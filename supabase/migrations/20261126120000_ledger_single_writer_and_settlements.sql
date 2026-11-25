-- Wave 5 finance (system audit; decision by the owner on 2026-11-25: customers pay the wash, so the
-- periodic "payout" is a SETTLEMENT — the commission each wash owes WashUp). Applied to
-- tbcmgdwzarfdgzzmmele through the SQL editor by the lead with the owner's authorisation; recorded in
-- schema_migrations.
--
-- GAP-019 single ledger writer: one trigger writes the commission row for EVERY order (app, walk-in,
--   phone) at creation, keeps it in step with the order total while pending, drops it on cancel /
--   no-show. The rate is recorded per row (history never changes when a wash's rate changes).
--   Panels keep setting paid / refunded / settled (status only).
-- GAP-011 (part): transactions and payouts carry their currency; commission is rounded to the
--   currency's decimals (KWD/BHD/JOD 3, IQD/LBP 0).
-- GAP-020: generate_settlements(start, end) creates one "due" statement per wash and currency from
--   paid, not-yet-settled ledger rows and links them (transactions.payout_id). Weekly cron for the
--   previous Monday–Sunday; admins can run it for any period.

begin;
set local lock_timeout = '5s';

alter table public.transactions add column if not exists currency text;
alter table public.transactions add column if not exists payout_id text references public.payouts(id) on delete set null;
alter table public.payouts add column if not exists currency text;
create index if not exists transactions_payout_id_idx on public.transactions (payout_id);

create or replace function public.branch_money(p_branch_id text, out currency text, out decimals int)
language sql stable security definer set search_path = '' as $$
  select c.currency, c.currency_decimals::int
  from public.branches b
  join public.areas a on a.id = b.area_id
  join public.countries c on c.code = a.country_code
  where b.id = p_branch_id
$$;
revoke all on function public.branch_money(text) from public, anon, authenticated;

create or replace function public.order_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate numeric;
  v_cur text;
  v_dec int;
  v_comm numeric;
begin
  select m.currency, m.decimals into v_cur, v_dec from public.branch_money(new.branch_id) m;
  v_dec := coalesce(v_dec, 2);
  if tg_op = 'INSERT' then
    if new.status in ('cancelled', 'no_show') then
      return new;
    end if;
    select coalesce(b.commission_rate,
                    (select (s.value ->> 'defaultPct')::numeric from public.platform_settings s where s.key = 'commission'),
                    7)
      into v_rate
    from public.businesses b where b.id = new.business_id;
    v_comm := round(new.total * coalesce(v_rate, 7) / 100, v_dec);
    insert into public.transactions (id, order_id, business_id, gross, commission_rate, commission, net_to_wash, date, status, currency)
    values ('txn_' || new.id, new.id, new.business_id, new.total, coalesce(v_rate, 7), v_comm, new.total - v_comm,
            new.scheduled_at, 'pending', coalesce(v_cur, 'EGP'))
    on conflict (order_id) do nothing;
  elsif new.status in ('cancelled', 'no_show') and old.status is distinct from new.status then
    delete from public.transactions where order_id = new.id and status = 'pending';
  elsif new.total is distinct from old.total then
    update public.transactions t
       set gross = new.total,
           commission = round(new.total * t.commission_rate / 100, v_dec),
           net_to_wash = new.total - round(new.total * t.commission_rate / 100, v_dec)
     where t.order_id = new.id and t.status = 'pending';
  end if;
  return new;
end
$$;
revoke all on function public.order_ledger() from public, anon, authenticated;

drop trigger if exists trg_app_order_ledger on public.orders;
drop trigger if exists trg_order_ledger on public.orders;
create trigger trg_order_ledger
  after insert or update of status, total on public.orders
  for each row execute function public.order_ledger();

update public.transactions t
   set currency = coalesce((select m.currency from public.orders o, public.branch_money(o.branch_id) m where o.id = t.order_id), 'EGP')
 where t.currency is null;

create or replace function public.generate_settlements(p_period_start date, p_period_end date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_id text;
  n int := 0;
begin
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'invalid_period';
  end if;
  for r in
    select t.business_id, coalesce(t.currency, 'EGP') as cur, sum(t.commission) as due, array_agg(t.id) as ids
    from public.transactions t
    where t.status = 'paid' and t.payout_id is null
      and t.date >= p_period_start::timestamptz and t.date < (p_period_end + 1)::timestamptz
    group by 1, 2
    having sum(t.commission) > 0
  loop
    insert into public.payouts (business_id, period_start, period_end, amount_due, amount_paid, status, currency)
    values (r.business_id, p_period_start, p_period_end, r.due, 0, 'due', r.cur)
    returning id into v_id;
    update public.transactions set payout_id = v_id where id = any (r.ids);
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function public.generate_settlements(date, date) from public, anon, authenticated;

select cron.schedule(
  'generate-settlements',
  '0 3 * * 1',
  $cron$select public.generate_settlements(current_date - 7, current_date - 1)$cron$
);

commit;

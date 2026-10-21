-- Commission ledger for customer-app orders, 2026-10-21.
--
-- The partner portal writes a pending `transactions` row with every walk-in/phone order and moves it to
-- paid/refunded with the payment. create_order (customer app RPC) does not, so app bookings were missing
-- from the Super Admin's ledger and payouts, and their commission was never tracked (73 orders when this
-- was written). This adds the row for every new app order, drops the pending row when any order is
-- cancelled or marked no-show (the customer app's cancel_order did not), and backfills the history.

create or replace function public.app_order_ledger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_rate numeric;
  v_commission numeric;
begin
  if tg_op = 'INSERT' then
    if new.source <> 'app' then return new; end if;
    select coalesce(b.commission_rate,
                    (select (s.value ->> 'defaultPct')::numeric from public.platform_settings s where s.key = 'commission'),
                    7)
      into v_rate
    from public.businesses b where b.id = new.business_id;
    v_commission := round(new.total * v_rate / 100, 2);
    insert into public.transactions (id, order_id, business_id, gross, commission_rate, commission, net_to_wash, date, status)
    values ('txn_' || new.id, new.id, new.business_id, new.total, v_rate, v_commission, new.total - v_commission, new.scheduled_at, 'pending')
    on conflict (order_id) do nothing;
  elsif new.status in ('cancelled', 'no_show') and old.status is distinct from new.status then
    delete from public.transactions where order_id = new.id and status = 'pending';
  end if;
  return new;
end $$;

revoke all on function public.app_order_ledger() from public, anon, authenticated;

drop trigger if exists trg_app_order_ledger on public.orders;
create trigger trg_app_order_ledger after insert or update of status on public.orders
  for each row execute function public.app_order_ledger();

-- Backfill: every live or finished app order without a ledger row.
insert into public.transactions (id, order_id, business_id, gross, commission_rate, commission, net_to_wash, date, status)
select 'txn_' || o.id, o.id, o.business_id, o.total, r.rate, round(o.total * r.rate / 100, 2),
       o.total - round(o.total * r.rate / 100, 2), o.scheduled_at,
       case o.payment_status when 'paid' then 'paid'::public.transaction_status
                             when 'refunded' then 'refunded'::public.transaction_status
                             else 'pending'::public.transaction_status end
from public.orders o
join public.businesses b on b.id = o.business_id
cross join lateral (select coalesce(b.commission_rate,
                                    (select (s.value ->> 'defaultPct')::numeric from public.platform_settings s where s.key = 'commission'),
                                    7) as rate) r
where o.source = 'app' and o.status not in ('cancelled', 'no_show')
  and not exists (select 1 from public.transactions t where t.order_id = o.id)
on conflict (order_id) do nothing;

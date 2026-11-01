-- Commission ledger: create the pending transaction when the order completes,
-- not when it is created. Cancel / no_show still drop any leftover pending row.

create or replace function public.app_order_ledger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_rate numeric;
  v_commission numeric;
begin
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status in ('cancelled', 'no_show') and old.status is distinct from new.status then
    delete from public.transactions where order_id = new.id and status = 'pending';
    return new;
  end if;

  if new.status = 'completed' and old.status is distinct from new.status then
    select coalesce(b.commission_rate,
                    (select (s.value ->> 'defaultPct')::numeric from public.platform_settings s where s.key = 'commission'),
                    7)
      into v_rate
    from public.businesses b where b.id = new.business_id;
    v_commission := round(new.total * v_rate / 100, 2);
    insert into public.transactions (id, order_id, business_id, gross, commission_rate, commission, net_to_wash, date, status)
    values ('txn_' || new.id, new.id, new.business_id, new.total, v_rate, v_commission, new.total - v_commission, new.scheduled_at, 'pending')
    on conflict (order_id) do nothing;
  end if;

  return new;
end $$;

-- Drop pending ledger rows for orders that never completed.
delete from public.transactions t
using public.orders o
where t.order_id = o.id and t.status = 'pending' and o.status not in ('completed');

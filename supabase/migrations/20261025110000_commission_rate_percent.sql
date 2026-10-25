-- Commission rates are percentages everywhere (platform default 7 = 7%, the Super Admin edits 0–30).
-- The account scripts stored 0.10 (meant as 10%), so those washes paid 0.1%: a 276 EGP order earned
-- 0.28 EGP. Rates below 1 are converted to percent, and their ledger rows recomputed. (2026-10-25)
update public.businesses set commission_rate = commission_rate * 100
where commission_rate is not null and commission_rate > 0 and commission_rate < 1;

update public.transactions t
set commission_rate = t.commission_rate * 100,
    commission = round(t.gross * t.commission_rate, 2),
    net_to_wash = t.gross - round(t.gross * t.commission_rate, 2)
where t.commission_rate > 0 and t.commission_rate < 1;

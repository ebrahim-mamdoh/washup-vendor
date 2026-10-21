-- Covering indexes for the 25 foreign keys the Supabase performance advisor lists as unindexed
-- (2026-10-21). They speed up joins/lookups on these columns and keep deletes/updates of the parent
-- rows from scanning the child tables. Small tables today, so each build is instant.

create index if not exists branch_amenities_amenity_id_idx on public.branch_amenities (amenity_id);
create index if not exists branch_blocked_slots_created_by_idx on public.branch_blocked_slots (created_by);
create index if not exists businesses_owner_staff_id_idx on public.businesses (owner_staff_id);
create index if not exists complaint_notes_author_admin_id_idx on public.complaint_notes (author_admin_id);
create index if not exists complaints_assigned_admin_id_idx on public.complaints (assigned_admin_id);
create index if not exists complaints_branch_id_idx on public.complaints (branch_id);
create index if not exists complaints_customer_id_idx on public.complaints (customer_id);
create index if not exists complaints_order_id_idx on public.complaints (order_id);
create index if not exists customer_notifications_order_id_idx on public.customer_notifications (order_id);
create index if not exists day_closings_closed_by_idx on public.day_closings (closed_by);
create index if not exists legacy_branch_shares_branch_id_idx on public.legacy_branch_shares (branch_id);
create index if not exists legacy_favorites_branch_id_idx on public.legacy_favorites (branch_id);
create index if not exists offer_categories_category_id_idx on public.offer_categories (category_id);
create index if not exists order_notes_author_staff_id_idx on public.order_notes (author_staff_id);
create index if not exists orders_assigned_staff_id_idx on public.orders (assigned_staff_id);
create index if not exists orders_closed_in_day_id_idx on public.orders (closed_in_day_id);
create index if not exists orders_vehicle_id_idx on public.orders (vehicle_id);
create index if not exists platform_settings_updated_by_idx on public.platform_settings (updated_by);
create index if not exists reviews_customer_id_idx on public.reviews (customer_id);
create index if not exists reviews_service_id_idx on public.reviews (service_id);
create index if not exists services_category_id_idx on public.services (category_id);
create index if not exists staff_shifts_reviewed_by_idx on public.staff_shifts (reviewed_by);
create index if not exists vendor_notifications_branch_id_idx on public.vendor_notifications (branch_id);
create index if not exists wash_applications_area_id_idx on public.wash_applications (area_id);
create index if not exists wash_applications_business_id_idx on public.wash_applications (business_id);

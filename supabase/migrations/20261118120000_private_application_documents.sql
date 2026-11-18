-- GAP-001 (system audit 2026-11-17): partners' KYC documents (commercial registry, tax card)
-- must not be readable through public URLs.
--
-- The "join as a wash" wizard uploads through vendor/app/api/v1/vendor/upload (service role,
-- whitelisted bucket and file types). Nothing reads these files by public URL: the Super Admin
-- shows document names only. Making the bucket private therefore breaks no screen; admins
-- will need short-lived signed URLs when document previews are added.
--
-- Not applied yet. Check first (read-only):
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets
--   where id in ('application-documents', 'branch-photos');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'application-documents',
  'application-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

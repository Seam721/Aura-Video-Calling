-- Aura uses authenticated private Broadcast channels for room signaling.
-- Run this in Supabase Dashboard -> SQL Editor for the same project as the app.
alter table realtime.messages enable row level security;

drop policy if exists "Aura members can receive room events" on realtime.messages;
create policy "Aura members can receive room events"
on realtime.messages
for select
to authenticated
using (realtime.topic() like 'aura-room-%');

drop policy if exists "Aura members can send room events" on realtime.messages;
create policy "Aura members can send room events"
on realtime.messages
for insert
to authenticated
with check (realtime.topic() like 'aura-room-%');

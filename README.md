# Aura Video — real-time video calling

This project now uses WebRTC for peer-to-peer audio/video and Supabase Auth + Realtime Broadcast/Presence for room signaling and chat.

## 1. Configure Supabase
1. Create a Supabase project.
2. In **Project Settings → API**, copy the Project URL and the publishable/anon key.
3. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. In **Authentication → URL Configuration**, add your local URL (for example `http://localhost:5173`) and your deployed Netlify URL to Site URL / Redirect URLs.
5. In **Project Settings → Realtime**, ensure Realtime is enabled for the project.
6. In the Supabase SQL Editor, open `supabase/realtime-policies.sql` from this project, paste its contents, and run it. These policies are required because Aura intentionally uses authenticated private channels; without them, room subscription will fail.

Do not put service-role keys in frontend variables.

## 2. Run locally
```bash
npm install
cp .env.example .env
# Edit .env with your Supabase values
npm run dev
```
Open the local URL in two different browsers/devices, create a meeting, and open the copied link on the second device. Allow camera and microphone permissions. HTTPS is required outside localhost.

## 3. Deploy to Netlify
Import the repository or upload the project. Build command: `npm run build`; publish directory: `dist`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Site configuration → Environment variables, then redeploy.

## 4. Network reliability (TURN)
The app includes public STUN servers for initial connectivity. Some mobile carriers, corporate networks, and symmetric NATs require TURN relay servers. For production reliability, provision a TURN service (for example coturn or a managed WebRTC TURN provider), then add its credentials to the ICE server list in `src/App.tsx` and redeploy. Never expose long-lived TURN credentials in a public repository; use short-lived credentials from a backend for a production launch.

## Important limitations
- Calls use peer-to-peer mesh connections. Each participant connects directly to every other participant, so this is best for small rooms (roughly 2–4 participants); use an SFU such as LiveKit or mediasoup for larger meetings.
- Signaling/chat are real-time Supabase Broadcast events; this starter does not persist chat or call history.
- The app does not include a TURN relay service by default. STUN-only calls may fail on some networks.
- The app uses authenticated private Realtime channels. The supplied SQL policies restrict access to the `aura-room-` topic prefix, but any authenticated user who obtains a room code can still join; use expiring, server-authorized room invitations for sensitive meetings.
- Screen share replaces outgoing camera video. Local preview remains the camera preview.

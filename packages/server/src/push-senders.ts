import type { PushSender } from "./push.js";

/* Push senders. Node only (the hosted server, main.ts): kept apart from push.ts so a phone or hub build of the server
 * never bundles web-push. */
/** Expo's push service (Android app). With an access token when Expo push security is on. */
export function expoSender(accessToken?: string, fetcher: typeof fetch = fetch): PushSender {
  return async (targets, m) => {
    const res = await fetcher("https://exp.host/--/api/v2/push/send", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(targets.map((t) => ({ to: t.target, title: m.title, body: m.body, data: { url: m.url }, sound: "default", channelId: "default" }))) });
    const out = (await res.json().catch(() => ({}))) as { data?: { status: string; details?: { error?: string } }[] };
    return (out.data ?? []).flatMap((d, i) => (d.status === "error" && d.details?.error === "DeviceNotRegistered" ? [targets[i]!.target] : []));
  };
}

/** Standard web push (installed PWAs, browsers), signed with the server's own VAPID key pair. */
export async function webPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): Promise<PushSender> {
  const wp = (await import("web-push")).default;
  wp.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return async (targets, m) => {
    const gone: string[] = [];
    await Promise.all(targets.map((t) => wp.sendNotification(JSON.parse(t.target), JSON.stringify(m), { TTL: 86400 }).catch((e: { statusCode?: number }) => {
      if (e.statusCode === 404 || e.statusCode === 410) gone.push(t.target);
    })));
    return gone;
  };
}

/*
 * Sending the email sign-in code. Node only (the hosted server, main.ts), kept apart from app.ts so phone and hub
 * builds never bundle the AWS SDK. Plain words, the code in the subject, no links: the person types the code.
 */
export async function sesSender(o: { region: string; from: string; network?: string; credentials?: { accessKeyId: string; secretAccessKey: string } }) {
  const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
  const ses = new SESv2Client({ region: o.region, ...(o.credentials ? { credentials: o.credentials } : {}) });
  const name = o.network ?? "the Bayanihan Network";
  return async (to: string, code: string) => {
    const text = `Your code to sign in to ${name} is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email; nobody can sign in without the code.\n`;
    const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#0f172a;line-height:1.5"><p>Your code to sign in to ${name}:</p>`
      + `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p><p style="color:#64748b">It works for 10 minutes. If you didn't ask for it, you can ignore this email; nobody can sign in without the code.</p></div>`;
    await ses.send(new SendEmailCommand({ FromEmailAddress: o.from, Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: `${code} is your sign-in code` }, Body: { Text: { Data: text }, Html: { Data: html } } } } }));
  };
}

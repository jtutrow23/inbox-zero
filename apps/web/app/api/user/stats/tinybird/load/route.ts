import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { getAuthSession } from "@/utils/auth";
import { withError } from "@/utils/middleware";
import { TinybirdEmail, getLastEmail, publishEmail } from "@inboxzero/tinybird";
import { gmail_v1 } from "googleapis";
import { getGmailClient } from "@/utils/gmail/client";
import { parseMessage } from "@/utils/mail";
import { getMessage } from "@/utils/gmail/message";
import { isDefined } from "@/utils/types";
import { sleep } from "@/utils/sleep";

export const maxDuration = 300;

const PAGE_SIZE = 200;

export type LoadTinybirdEmailsResponse = Awaited<
  ReturnType<typeof publishAllEmails>
>;

async function publishAllEmails(options: {
  ownerEmail: string;
  gmail: gmail_v1.Gmail;
}) {
  const { ownerEmail, gmail } = options;

  let nextPageToken: string | undefined = undefined;
  let pages = 0;

  const lastEmailSaved = await getLastEmail({
    ownerEmail,
    direction: "oldest",
  });

  const before = lastEmailSaved.data?.[0].timestamp;
  console.log("Loading emails before:", before);
  // const after = `after:${startOfDayInSeconds}`;

  while (true) {
    console.log("Page", pages);
    let res;
    try {
      res = await saveBatch({ ownerEmail, gmail, nextPageToken, before });
    } catch (error) {
      console.log("Rate limited. Waiting 10 seconds...");
      await sleep(10_000);
      res = await saveBatch({ ownerEmail, gmail, nextPageToken, before });
    }

    nextPageToken = res.data.nextPageToken ?? undefined;

    if (!res.data.messages || res.data.messages.length < PAGE_SIZE) break;
    else pages++;
  }

  return { pages };
}

async function saveBatch(options: {
  ownerEmail: string;
  gmail: gmail_v1.Gmail;
  nextPageToken?: string;
  before?: number;
}) {
  const { ownerEmail, gmail, nextPageToken, before } = options;

  // 1. find all emails since the last time we ran this function
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: PAGE_SIZE,
    pageToken: nextPageToken,
    q: before ? `before:${before / 1000 + 1}` : undefined,
  });

  // 2. fetch each email and publish it to tinybird
  const emailsToPublish: TinybirdEmail[] = (
    await Promise.all(
      res.data.messages?.map(async (m) => {
        if (!m.id || !m.threadId) return;

        console.log("Fetching message", m.id);

        const message = await getMessage(m.id, gmail);
        const parsedEmail = parseMessage(message);

        const unsubscribeLink = parsedEmail.textHtml
          ? findUnsubscribeLink(parsedEmail.textHtml)
          : undefined;

        const tinybirdEmail: TinybirdEmail = {
          ownerEmail,
          threadId: m.threadId,
          gmailMessageId: m.id,
          from: parsedEmail.headers.from,
          to: parsedEmail.headers.to || "Missing",
          subject: parsedEmail.headers.subject,
          timestamp: +new Date(parsedEmail.headers.date),
          unsubscribeLink,
          read: !parsedEmail.labelIds?.includes("UNREAD"),
          sent: !!parsedEmail.labelIds?.includes("SENT"),
          draft: !!parsedEmail.labelIds?.includes("DRAFT"),
          inbox: !!parsedEmail.labelIds?.includes("INBOX"),
          sizeEstimate: message.sizeEstimate,
        };

        return tinybirdEmail;
      }) || []
    )
  ).filter(isDefined);

  console.log("Publishing", emailsToPublish.length, "emails");

  await publishEmail(emailsToPublish);

  return res;
}

function findUnsubscribeLink(html: string) {
  const $ = cheerio.load(html);
  let unsubscribeLink: string | undefined;

  $("a").each((_index, element) => {
    const text = $(element).text().toLowerCase();
    if (text.includes("unsubscribe")) {
      unsubscribeLink = $(element).attr("href");
      return false; // break the loop
    }
  });

  return unsubscribeLink;
}

export const POST = withError(async (request: Request) => {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" });

  const gmail = getGmailClient(session);

  const result = await publishAllEmails({
    ownerEmail: session.user.email,
    gmail,
  });

  return NextResponse.json(result);
});
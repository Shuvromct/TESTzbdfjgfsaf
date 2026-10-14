import { S3Client, PutObjectCommand, DeleteObjectCommand,
         ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Photographs live in Cloudflare R2, not in Postgres and not on Vercel.
 *
 * R2 because reading is free. Forty-six tasks' worth of before-and-after
 * pictures will be opened again and again — by the Director every week, by the
 * Pro-VC at each gate, by whoever audits the file afterwards — and on every
 * other object store that traffic is the bill. Ten gigabytes is far more than
 * this project will use: four hundred photographs at a megabyte each is 400 MB.
 *
 * The browser uploads straight to the bucket with a signed URL, so the image
 * never passes through a serverless function. That keeps the upload fast on
 * campus mobile data and keeps us clear of the request size limit.
 */
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set — photographs cannot be stored yet.`);
  return v;
};

export const r2Ready = () =>
  !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
     process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && process.env.R2_PUBLIC_BASE);

let client: S3Client | null = null;
function s3() {
  if (client) return client;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${need('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: need('R2_ACCESS_KEY_ID'),
      secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
    },
  });
  return client;
}

/** A URL the browser may PUT one file to, good for ten minutes. */
export async function signPut(key: string, contentType: string) {
  const cmd = new PutObjectCommand({
    Bucket: need('R2_BUCKET'), Key: key, ContentType: contentType,
  });
  return getSignedUrl(s3(), cmd, { expiresIn: 600 });
}

export async function removeObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: need('R2_BUCKET'), Key: key }));
}

export const publicUrl = (key: string) => `${need('R2_PUBLIC_BASE')}/${key}`;

/** The key a stored URL points at — the path after the public hostname. */
export const keyOf = (url: string) => String(url || '').split('/').slice(3).join('/');

/**
 * Everything in the bucket.
 *
 * Needed because the bucket only ever grows: a photograph taken off a task
 * leaves its file behind on purpose, and an upload interrupted halfway
 * leaves one behind that nothing will ever point at. Without a listing
 * there is no way to tell those two apart, or to find either.
 *
 * Paged, because a thousand objects arrive a thousand at a time, and
 * capped so that a runaway bucket cannot hang the request.
 */
export async function listObjects(max = 10_000) {
  const out: { key: string; size: number; at: Date | undefined }[] = [];
  let token: string | undefined;
  do {
    const r: any = await s3().send(new ListObjectsV2Command({
      Bucket: need('R2_BUCKET'), ContinuationToken: token, MaxKeys: 1000,
    }));
    for (const o of (r.Contents || []))
      out.push({ key: String(o.Key), size: Number(o.Size || 0), at: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token && out.length < max);
  return out;
}

/** Where a photograph of a task goes. Sorted by task, so the bucket stays readable. */
export function photoKey(taskId: string, kind: string, id: string, thumb = false) {
  const safe = taskId.replace(/[^A-Za-z0-9.\-]/g, '_');
  return `tasks/${safe}/${kind}/${id}${thumb ? '_thumb' : ''}.jpg`;
}

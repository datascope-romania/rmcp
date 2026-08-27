import {
  BucketAlreadyOwnedByYou, CreateBucketCommand, DeleteObjectCommand, HeadBucketCommand,
  NotFound, PutBucketTaggingCommand, PutObjectCommand, S3Client, type BucketLocationConstraint,
} from "@aws-sdk/client-s3";

export function bucketName(accountId: string, region: string): string {
  return `rmcp-deploy-${accountId}-${region}`;
}

export async function ensureBucket(s3: S3Client, bucket: string, region: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
  }
  try {
    await s3.send(new CreateBucketCommand({
      Bucket: bucket,
      // us-east-1 must be requested without a LocationConstraint
      ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
    }));
  } catch (err) {
    if (!(err instanceof BucketAlreadyOwnedByYou)) throw err;
  }
  await s3.send(new PutBucketTaggingCommand({
    Bucket: bucket,
    Tagging: { TagSet: [{ Key: "rmcp:managed", Value: "true" }] },
  }));
}

export async function uploadZip(s3: S3Client, bucket: string, key: string, body: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

export async function deleteZip(s3: S3Client, bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

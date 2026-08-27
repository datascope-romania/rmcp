import { BucketAlreadyOwnedByYou, CreateBucketCommand, DeleteObjectCommand, HeadBucketCommand, NotFound, PutBucketTaggingCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { bucketName, deleteZip, ensureBucket, uploadZip } from "../src/s3.js";

const s3Mock = mockClient(S3Client);
const client = new S3Client({ region: "us-east-1" });
beforeEach(() => s3Mock.reset());

describe("bucketName", () => {
  it("is deterministic per account and region", () => {
    expect(bucketName("123456789012", "eu-west-1")).toBe("rmcp-deploy-123456789012-eu-west-1");
  });
});

describe("ensureBucket", () => {
  it("does nothing when the bucket exists", async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    await ensureBucket(client, "b", "us-east-1");
    expect(s3Mock.commandCalls(CreateBucketCommand)).toHaveLength(0);
  });

  it("creates and tags a missing bucket (no LocationConstraint in us-east-1)", async () => {
    s3Mock.on(HeadBucketCommand).rejects(new NotFound({ message: "nope", $metadata: {} }));
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketTaggingCommand).resolves({});
    await ensureBucket(client, "b", "us-east-1");
    const create = s3Mock.commandCalls(CreateBucketCommand)[0].args[0].input;
    expect(create.CreateBucketConfiguration).toBeUndefined();
    expect(s3Mock.commandCalls(PutBucketTaggingCommand)).toHaveLength(1);
  });

  it("passes the LocationConstraint outside us-east-1", async () => {
    s3Mock.on(HeadBucketCommand).rejects(new NotFound({ message: "nope", $metadata: {} }));
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketTaggingCommand).resolves({});
    await ensureBucket(client, "b", "eu-west-1");
    const create = s3Mock.commandCalls(CreateBucketCommand)[0].args[0].input;
    expect(create.CreateBucketConfiguration?.LocationConstraint).toBe("eu-west-1");
  });

  it("tolerates a concurrent create (BucketAlreadyOwnedByYou)", async () => {
    s3Mock.on(HeadBucketCommand).rejects(new NotFound({ message: "nope", $metadata: {} }));
    s3Mock.on(CreateBucketCommand).rejects(new BucketAlreadyOwnedByYou({ message: "own", $metadata: {} }));
    s3Mock.on(PutBucketTaggingCommand).resolves({});
    await expect(ensureBucket(client, "b", "us-east-1")).resolves.toBeUndefined();
  });
});

describe("uploadZip / deleteZip", () => {
  it("puts and deletes the object", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    await uploadZip(client, "b", "functions/x.zip", Buffer.from("zip"));
    await deleteZip(client, "b", "functions/x.zip");
    expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Key).toBe("functions/x.zip");
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });
});

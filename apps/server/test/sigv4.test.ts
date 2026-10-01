import { describe, expect, it } from "vitest";
import { sha256Hex, signV4 } from "../src/services/exports/sigv4.js";

/**
 * AWS's published Signature Version 4 vectors: the "aws-sig-v4-test-suite" (get-vanilla, post-vanilla,
 * get-vanilla-query-order-key-case; credentials AKIDEXAMPLE, 2015-08-30T12:36:00Z, us-east-1, service "service") and the
 * S3 examples in "Authenticating Requests: Using the Authorization Header" (examplebucket, 2013-05-24).
 */
const suite = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service", now: new Date("2015-08-30T12:36:00Z") };
const s3 = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3", now: new Date("2013-05-24T00:00:00Z"), contentSha256Header: true };

describe("SigV4 (AWS test vectors)", () => {
  it("get-vanilla", async () => {
    const r = await signV4({ ...suite, method: "GET", url: "https://example.amazonaws.com/" });
    expect(r.canonicalRequest).toBe("GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(r.stringToSign).toBe("AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
    expect(r.headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });
  it("post-vanilla", async () => {
    const r = await signV4({ ...suite, method: "POST", url: "https://example.amazonaws.com/" });
    expect(r.signature).toBe("5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b");
  });
  it("get-vanilla-query-order-key-case", async () => {
    const r = await signV4({ ...suite, method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1" });
    expect(r.signature).toBe("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });
  it("S3 GET object with a Range header", async () => {
    const r = await signV4({ ...s3, method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { range: "bytes=0-9" } });
    expect(r.headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });
  it("S3 PUT object", async () => {
    const body = "Welcome to Amazon S3.";
    expect(await sha256Hex(body)).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const r = await signV4({ ...s3, method: "PUT", url: "https://examplebucket.s3.amazonaws.com/test$file.text", body,
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" } });
    expect(r.signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });
  it("S3 GET bucket lifecycle (empty-valued query parameter)", async () => {
    const r = await signV4({ ...s3, method: "GET", url: "https://examplebucket.s3.amazonaws.com/?lifecycle" });
    expect(r.signature).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });
  it("S3 GET bucket list objects", async () => {
    const r = await signV4({ ...s3, method: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J" });
    expect(r.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

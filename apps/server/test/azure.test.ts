import { describe, expect, it } from "vitest";
import { azureUrl, parseConnectionString, sharedKeyAuthorization } from "../src/services/exports/azure.js";

/**
 * Azure Blob Storage Shared Key signing. The expected signatures were made by Microsoft's JavaScript SDK
 * (@azure/storage-blob 12.34, StorageSharedKeyCredential) for the same requests, captured before sending.
 */

const KEY = "AAMGCQwPEhUYGx4hJCcqLTAzNjk8P0JFSEtOUVRXWl1gY2ZpbG9ydXh7foGEh4qNkJOWmZyfoqWoq66xtLe6vQ==";
const DATE = "Sat, 03 Oct 2026 23:24:52 GMT";

describe("Azure Shared Key", () => {
  it("signs Put Blob like Microsoft's SDK", async () => {
    const r = await sharedKeyAuthorization({
      method: "PUT", url: "https://acmeexports.blob.core.windows.net/rd-exports/rd/2026-09-01/transactions_20260901T120000Z.csv.gz", accountName: "acmeexports", accountKey: KEY,
      headers: { "Content-Type": "application/octet-stream", "x-ms-version": "2026-10-06", "Content-Length": "13", "x-ms-blob-content-type": "application/gzip", "x-ms-blob-type": "BlockBlob", "x-ms-client-request-id": "66427bab-5256-4fb2-b7dc-328b76b9fa30", "x-ms-date": DATE },
    });
    expect(r.authorization).toBe("SharedKey acmeexports:xaotK9Ev6UFu8p4Hs95Yzk6iFVptDUx72osZ5YtiknA=");
  });

  it("signs Get Container Properties (a query string) like Microsoft's SDK", async () => {
    const r = await sharedKeyAuthorization({
      method: "GET", url: "https://acmeexports.blob.core.windows.net/rd-exports?restype=container", accountName: "acmeexports", accountKey: KEY,
      headers: { "x-ms-version": "2026-10-06", "x-ms-client-request-id": "326daf3f-e5b0-4c70-8c80-893a5154d222", "x-ms-date": DATE },
    });
    expect(r.authorization).toBe("SharedKey acmeexports:oIF+nzbvCqGAz45LRW+IgStts296IfyK3LV2z5hSv3A=");
  });

  it("signs for the Azurite emulator (path-style account) like Microsoft's SDK", async () => {
    const a = parseConnectionString("UseDevelopmentStorage=true");
    expect(azureUrl(a, "ctr", "a b/c.csv")).toBe("http://127.0.0.1:10000/devstoreaccount1/ctr/a%20b/c.csv");
    const r = await sharedKeyAuthorization({
      method: "PUT", url: azureUrl(a, "ctr", "a b/c.csv"), accountName: a.accountName!, accountKey: a.accountKey!,
      headers: { "Content-Type": "application/octet-stream", "x-ms-version": "2026-10-06", "Content-Length": "13", "x-ms-blob-content-type": "text/csv", "x-ms-blob-type": "BlockBlob", "x-ms-client-request-id": "740b3245-f067-48c4-888b-314d851c1bca", "x-ms-date": DATE },
    });
    expect(r.authorization).toBe("SharedKey devstoreaccount1:bvK8dB0xtYSeSlqpNaY7jqCv2y45UoMrZ7YeCsAiCzA=");
  });

  it("reads connection strings: account key, endpoint suffix, custom endpoint with a SAS, and bad ones", () => {
    expect(parseConnectionString(`DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${KEY};EndpointSuffix=core.chinacloudapi.cn`))
      .toEqual({ blobEndpoint: "https://acme.blob.core.chinacloudapi.cn", accountName: "acme", accountKey: KEY, sas: null });
    const sas = parseConnectionString("BlobEndpoint=https://acme.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&ss=b&sig=abc%3D");
    expect(sas).toEqual({ blobEndpoint: "https://acme.blob.core.windows.net", accountName: null, accountKey: null, sas: "sv=2022-11-02&ss=b&sig=abc%3D" });
    expect(azureUrl(sas, "ctr", "d/f.csv")).toBe("https://acme.blob.core.windows.net/ctr/d/f.csv?sv=2022-11-02&ss=b&sig=abc%3D");
    expect(azureUrl(sas, "ctr", undefined, { restype: "container" })).toBe("https://acme.blob.core.windows.net/ctr?restype=container&sv=2022-11-02&ss=b&sig=abc%3D");
    expect(() => parseConnectionString("AccountName=acme")).toThrow(/AccountKey or a SharedAccessSignature/);
    expect(() => parseConnectionString("nonsense")).toThrow(/AccountName or BlobEndpoint/);
  });
});

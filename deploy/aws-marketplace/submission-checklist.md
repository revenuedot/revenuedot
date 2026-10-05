# AWS Marketplace submission checklist

What is ready in this folder, and what is left before the listing can go live. Nothing has been submitted and no AWS
Marketplace seller account exists yet. Spec: `prd/ha-self-host/PRD.md`.

## Ready
- `product.yaml`: title, short and long description, highlights, categories, keywords, resources, support, the two
  delivery options (Helm chart on EKS, container image on ECS), release notes and compliance answers.
- `usage-instructions.md`: the usage instructions field for both delivery options.
- `architecture.svg` and `architecture.png` (1100 x 700): the architecture diagram.
- The Helm chart (`deploy/helm/revenuedot`) and the ECS Terraform (`deploy/terraform/aws`) the listing points to, both
  checked in CI (helm lint, kubeconform, terraform validate, tflint).
- Both delivery options run the image as uid 1000 on a read-only root filesystem. The image's own default user is still
  root (see "Left to do").

## Left to do, in order
1. **Pricing model (an owner decision).** Options for a container product:
   - **Contract pricing** (annual, entitlements through AWS License Manager), sold mostly through private offers. Fits
     the Enterprise sale ("custom pricing, from $50,000 a year"); the server would check the License Manager
     entitlement in place of, or next to, `REVENUEDOT_LICENSE_KEY`.
   - **BYOL**: a free listing; the customer buys the licence from us and sets `REVENUEDOT_LICENSE_KEY`. Fastest to ship,
     no AWS integration, but no purchase through the customer's AWS bill.
   - **Free** (open-source only): discovery only, no revenue through AWS. Not recommended: self-hosting is not a plan
     RevenueDot sells (Kai, 2026-10-05). The commercial licence to self-host is part of Enterprise, so this listing is an
     Enterprise channel (contract pricing or BYOL).
   Hourly or per-pod usage pricing does not fit: it needs the AWS Marketplace Metering Service in the image and prices
   the infrastructure rather than the licence.
2. **Seller registration (an owner).** Register the company that sells RevenueDot as an AWS Marketplace seller in the AWS Marketplace Management
   Portal: legal entity, tax interview, and the bank account for disbursement. An agent must not do this step.
3. **EULA.** Use the Standard Contract for AWS Marketplace with the RevenueDot Enterprise License (`ee/LICENSE`) as the
   addendum for `ee/` features, or attach the order form, MSA and DPA. Legal text is adopted, never drafted.
4. **Default user.** Decide whether the image switches to `USER node` (uid 1000). Docker compose installs keep archives
   in a volume the old root image wrote, so the switch needs that volume handled (`chown`, or `user: root` in compose).
5. **Publish the image.** A tagged, multi-architecture image (`linux/amd64` and `linux/arm64`) built from the repo
   `Dockerfile`, pushed to the ECR repositories the portal creates for the listing, plus the Helm chart as an OCI
   artifact (`helm package deploy/helm/revenuedot && helm push revenuedot-0.1.0.tgz oci://<marketplace-ecr>/revenuedot`).
   AWS scans both for known vulnerabilities; fix any critical finding before submitting.
6. **Fill the form** from `product.yaml`, upload the 120 x 120 logo and the PNG diagram, submit the product, then each
   version. AWS reviews the listing and every version.
7. **After approval:** add the Marketplace link to revenuedot.app (pricing and the self-host page), the docs and
   `company/marketing/seo-aeo.md`.

## Checks before each version
- `helm lint --strict` and `kubeconform` pass on the chart in the version (CI job `deploy`).
- `scripts/e2e/cluster/run.ts` passes on the image's commit (three replicas, no duplicate webhooks or emails).
- The usage instructions' commands work on a clean EKS cluster and a clean AWS account (to do once before the first
  submission: it creates billable resources).

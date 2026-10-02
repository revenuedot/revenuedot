locals {
  create_certificate = var.certificate_arn == ""
  certificate_arn    = local.create_certificate ? aws_acm_certificate_validation.main[0].certificate_arn : var.certificate_arn
}

resource "aws_acm_certificate" "main" {
  count             = local.create_certificate ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = var.route53_zone_id != ""
      error_message = "Set route53_zone_id so the certificate can be validated, or bring your own certificate_arn."
    }
  }
}

resource "aws_route53_record" "validation" {
  for_each = local.create_certificate ? {
    for o in aws_acm_certificate.main[0].domain_validation_options : o.domain_name => o
  } : {}
  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  count                   = local.create_certificate ? 1 : 0
  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_route53_record" "app" {
  count   = var.route53_zone_id == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

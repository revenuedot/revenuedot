{{/* Names */}}
{{- define "revenuedot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "revenuedot.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "revenuedot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "revenuedot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "revenuedot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The API and dashboard pods only (not the migration Job or the evaluation Postgres). */}}
{{- define "revenuedot.serverSelectorLabels" -}}
{{ include "revenuedot.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "revenuedot.labels" -}}
helm.sh/chart: {{ include "revenuedot.chart" . }}
{{ include "revenuedot.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: revenuedot
{{- end -}}

{{- define "revenuedot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "revenuedot.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "revenuedot.image" -}}
{{- $repo := required "Set image.repository (the published image is ghcr.io/revenuedot/revenuedot)." .Values.image.repository -}}
{{- printf "%s:%s" $repo (default "latest" .Values.image.tag) -}}
{{- end -}}

{{/* The public address: publicUrl, else the first Ingress host. */}}
{{- define "revenuedot.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts -}}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) (index .Values.ingress.hosts 0).host -}}
{{- else -}}
{{- fail "Set publicUrl (the address people and the stores reach RevenueDot at), or enable the Ingress." -}}
{{- end -}}
{{- end -}}

{{/* Where DATABASE_URL comes from: name and key of a Secret. */}}
{{- define "revenuedot.databaseSecretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else if .Values.postgresql.enabled -}}
{{- printf "%s-postgresql" (include "revenuedot.fullname" .) -}}
{{- else -}}
{{- printf "%s-database" (include "revenuedot.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "revenuedot.databaseSecretKey" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecretKey -}}
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end -}}

{{/* Exactly one database source. */}}
{{- define "revenuedot.validateDatabase" -}}
{{- $sources := 0 -}}
{{- if .Values.database.existingSecret }}{{ $sources = add1 $sources }}{{ end -}}
{{- if .Values.database.url }}{{ $sources = add1 $sources }}{{ end -}}
{{- if .Values.postgresql.enabled }}{{ $sources = add1 $sources }}{{ end -}}
{{- if ne (int $sources) 1 -}}
{{- fail "Choose exactly one database: database.existingSecret (production), database.url, or postgresql.enabled=true (evaluation only)." -}}
{{- end -}}
{{- if ge (add (int .Values.shutdown.delayMs) (int .Values.shutdown.timeoutMs)) (mul (int .Values.terminationGracePeriodSeconds) 1000) -}}
{{- fail "shutdown.delayMs + shutdown.timeoutMs must be less than terminationGracePeriodSeconds, or Kubernetes kills replicas mid-drain." -}}
{{- end -}}
{{- if lt (int .Values.database.poolMax) 2 -}}
{{- fail "database.poolMax must be at least 2 (one connection is reserved for the cluster locks)." -}}
{{- end -}}
{{- end -}}

{{/* job or startup, from migrations.mode. */}}
{{- define "revenuedot.migrationMode" -}}
{{- $m := .Values.migrations.mode -}}
{{- if eq $m "auto" -}}
{{- ternary "job" "startup" (not (empty .Values.database.existingSecret)) -}}
{{- else if eq $m "job" -}}
{{- if not .Values.database.existingSecret -}}
{{- fail "migrations.mode=job needs database.existingSecret: the hook Job runs before the chart's own Secrets exist." -}}
{{- end -}}
job
{{- else if eq $m "startup" -}}
startup
{{- else -}}
{{- fail "migrations.mode must be auto, job or startup." -}}
{{- end -}}
{{- end -}}

{{- define "revenuedot.chartSecretName" -}}
{{- printf "%s-secrets" (include "revenuedot.fullname" .) -}}
{{- end -}}

{{/* True when the chart makes the Secret for secrets.* values. */}}
{{- define "revenuedot.hasChartSecret" -}}
{{- $s := .Values.secrets -}}
{{- if and (not $s.existingSecret) (or $s.encryptionKey $s.signingKey $s.smtpUrl $s.licenseKey $s.anthropicApiKey $s.openaiApiKey $s.archiveS3AccessKeyId $s.archiveS3SecretAccessKey) -}}
true
{{- end -}}
{{- end -}}

{{/* Container env shared by the Deployment and the migration Job. */}}
{{- define "revenuedot.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "revenuedot.databaseSecretName" . }}
      key: {{ include "revenuedot.databaseSecretKey" . }}
- name: DATABASE_POOL_MAX
  value: {{ .Values.database.poolMax | quote }}
{{- end -}}

{{- define "dmf-cms.name" -}}
dmf-cms
{{- end -}}

{{- define "dmf-cms.fullname" -}}
{{- printf "%s" (include "dmf-cms.name" .) -}}
{{- end -}}

{{- define "dmf-cms.labels" -}}
app.kubernetes.io/name: {{ include "dmf-cms.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Name of the dedicated ServiceAccount that writes setup-request receipts. The
dmf-cms and dmf-infra charts share this name as an interface, so it is a
constant and not a value.
*/}}
{{- define "dmf-cms.setupRequestsServiceAccount" -}}
dmf-cms-setup-requests
{{- end -}}

{{/*
Renders "true" when both setup-request bindings are set. A blank binding keeps
the receipt endpoint disabled, and the chart then creates no receipt RBAC.
*/}}
{{- define "dmf-cms.setupRequestsEnabled" -}}
{{- if and .Values.setupRequests.envId .Values.setupRequests.clusterUid -}}true{{- end -}}
{{- end -}}

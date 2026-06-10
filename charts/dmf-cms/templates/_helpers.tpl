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

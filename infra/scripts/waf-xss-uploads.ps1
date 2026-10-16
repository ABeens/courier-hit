# Deja de bloquear en el WAF las subidas de PDF que la regla XSS confunde con un
# ataque, sin tocar el resto del stack.
#
# Por que existe: `AWSManagedRulesCommonRuleSet` / `CrossSiteScripting_BODY` lee
# los bytes del PDF adjunto a una prealerta como si fueran HTML y responde 403
# (en HTML). El portal solo muestra "No se pudo registrar la prealerta." y la
# peticion nunca llega a la API.
#
# Aplica el MISMO cambio que ya describe infra/lib/app-stack.ts:
#   1. `CrossSiteScripting_BODY` pasa a contar dentro del grupo comun.
#   2. Regla nueva `BlockXssBodyOutsideUploads` (prioridad 5): bloquea por esa
#      etiqueta todo lo que NO es multipart/form-data.
# Asi un `cdk deploy` posterior no encuentra nada distinto que aplicar.
#
# Se hace por la CLI y no con `cdk deploy` para no arriesgar un reemplazo de la
# instancia (rotacion de AMI) solo por cambiar una regla del borde.
#
# Es idempotente: si el cambio ya esta, no hace nada.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\waf-xss-uploads.ps1

$ErrorActionPreference = 'Stop'
$Region = 'us-east-1'
$Scope = 'CLOUDFRONT'
$RuleName = 'BlockXssBodyOutsideUploads'
$GroupName = 'AWSManagedRulesCommonRuleSet'

function Invoke-Aws {
  $out = & aws @args
  if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') fallo con codigo $LASTEXITCODE." }
  return $out
}

# JSON sin BOM: la CLI de AWS no acepta el BOM que escribe Out-File en PowerShell 5.1.
function Write-JsonFile($value, $path) {
  $json = ConvertTo-Json -InputObject $value -Depth 50
  [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
}

$aclArn = Invoke-Aws wafv2 list-web-acls --scope $Scope --region $Region --query 'WebACLs[0].ARN' --output text
if (-not $aclArn -or $aclArn -eq 'None') { throw 'No encuentro el Web ACL de CloudFront.' }
$aclId = ($aclArn -split '/')[-1]
$aclName = ($aclArn -split '/')[-2]
Write-Host "Web ACL: $aclName ($aclId)"

$resp = (Invoke-Aws wafv2 get-web-acl --scope $Scope --region $Region --name $aclName --id $aclId --output json) -join "`n" | ConvertFrom-Json
$acl = $resp.WebACL
$rules = @($acl.Rules)

$group = $rules | Where-Object { $_.Name -eq $GroupName } | Select-Object -First 1
if (-not $group) { throw "El Web ACL no tiene la regla $GroupName." }
$managed = $group.Statement.ManagedRuleGroupStatement

$changed = $false

$overrides = @($managed.RuleActionOverrides | Where-Object { $_ })
if (-not ($overrides | Where-Object { $_.Name -eq 'CrossSiteScripting_BODY' })) {
  $overrides += [pscustomobject]@{ Name = 'CrossSiteScripting_BODY'; ActionToUse = [pscustomobject]@{ Count = [pscustomobject]@{} } }
  $managed | Add-Member -NotePropertyName RuleActionOverrides -NotePropertyValue $overrides -Force
  $changed = $true
  Write-Host '+ CrossSiteScripting_BODY pasa a contar en el grupo comun.'
}

if (-not ($rules | Where-Object { $_.Name -eq $RuleName })) {
  $rules += [pscustomobject]@{
    Name      = $RuleName
    Priority  = 5
    Action    = [pscustomobject]@{ Block = [pscustomobject]@{} }
    Statement = [pscustomobject]@{
      AndStatement = [pscustomobject]@{
        Statements = @(
          [pscustomobject]@{
            LabelMatchStatement = [pscustomobject]@{
              Scope = 'LABEL'
              Key   = 'awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body'
            }
          },
          [pscustomobject]@{
            NotStatement = [pscustomobject]@{
              Statement = [pscustomobject]@{
                ByteMatchStatement = [pscustomobject]@{
                  FieldToMatch         = [pscustomobject]@{ SingleHeader = [pscustomobject]@{ Name = 'content-type' } }
                  PositionalConstraint = 'STARTS_WITH'
                  # Es un blob: la CLI v2 lo espera en base64 (las reglas que ya
                  # existen vuelven asi de `get-web-acl` y pasan tal cual).
                  SearchString         = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('multipart/form-data'))
                  TextTransformations  = @([pscustomobject]@{ Priority = 0; Type = 'LOWERCASE' })
                }
              }
            }
          }
        )
      }
    }
    VisibilityConfig = [pscustomobject]@{
      SampledRequestsEnabled   = $true
      CloudWatchMetricsEnabled = $true
      MetricName               = 'xss-body-outside-uploads'
    }
  }
  $changed = $true
  Write-Host "+ Regla $RuleName (bloquea XSS en todo lo que no es una subida)."
}

if (-not $changed) {
  Write-Host 'El WAF ya tiene el cambio. Nada que hacer.'
  exit 0
}

$tmp = Join-Path $env:TEMP "waf-xss-uploads-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $rulesFile = Join-Path $tmp 'rules.json'
  $defaultFile = Join-Path $tmp 'default.json'
  $visibilityFile = Join-Path $tmp 'visibility.json'
  Write-JsonFile @($rules) $rulesFile
  Write-JsonFile $acl.DefaultAction $defaultFile
  Write-JsonFile $acl.VisibilityConfig $visibilityFile

  $update = @(
    'wafv2', 'update-web-acl', '--scope', $Scope, '--region', $Region,
    '--name', $aclName, '--id', $aclId, '--lock-token', $resp.LockToken,
    '--default-action', "file://$defaultFile",
    '--visibility-config', "file://$visibilityFile",
    '--rules', "file://$rulesFile"
  )
  if ($acl.Description) { $update += @('--description', $acl.Description) }
  Invoke-Aws @update | Out-Null
}
finally { Remove-Item -Recurse -Force $tmp }

Write-Host ''
Write-Host 'Listo. CloudFront tarda uno o dos minutos en propagar el cambio; despues'
Write-Host 'vuelve a intentar la prealerta desde el portal.'

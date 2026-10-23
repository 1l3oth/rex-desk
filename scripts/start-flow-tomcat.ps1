param(
  [Parameter(Mandatory=$true)][string]$Worktree,
  [Parameter(Mandatory=$true)][string]$Runtime,
  [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
  [Parameter(Mandatory=$true)][string]$TemplateBase,
  [Parameter(Mandatory=$true)][string]$JavaHome,
  [Parameter(Mandatory=$true)][string]$CatalinaHome,
  [ValidateRange(256,4096)][int]$MaxHeapMb = 512,
  [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$worktreePath = [IO.Path]::GetFullPath($Worktree)
$runtimePath = [IO.Path]::GetFullPath($Runtime)
$templatePath = [IO.Path]::GetFullPath($TemplateBase)
if ($runtimePath -eq $templatePath -or $runtimePath.StartsWith($worktreePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Runtime must be separate from the source worktree and Tomcat template.'
}
$java = Join-Path $JavaHome 'bin/java.exe'
$bootstrap = Join-Path $CatalinaHome 'bin/bootstrap.jar'
if (!(Test-Path -LiteralPath $java) -or !(Test-Path -LiteralPath $bootstrap)) { throw 'Java 8 or the Tomcat installation is missing. Check repository settings.' }
$javaVersion = (& $java -version 2>&1 | Out-String)
if ($javaVersion -notmatch 'version "1\.8\.') { throw 'Flow requires Java 8. Select a Java 8 home in repository settings.' }
$sourceRoot = Join-Path $worktreePath 'src'
if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'WEB-INF'))) { throw 'Selected branch has no src/WEB-INF application.' }
foreach ($folder in @('conf','logs','temp','work','webapps','conf/Catalina/localhost')) {
  New-Item -ItemType Directory -Path (Join-Path $runtimePath $folder) -Force | Out-Null
}
# Copy only configuration files and the root application descriptor. No existing deployment or logs are reused.
Get-ChildItem -LiteralPath (Join-Path $templatePath 'conf') -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimePath 'conf') -Force
}
$serverFile = Join-Path $runtimePath 'conf/server.xml'
$server = New-Object System.Xml.XmlDocument
$server.XmlResolver = $null
$server.Load($serverFile)
$server.DocumentElement.SetAttribute('port', '-1')
$connectors = @($server.SelectNodes('//Connector'))
$http = $connectors | Where-Object { $_.GetAttribute('protocol') -notmatch 'AJP' -and $_.GetAttribute('SSLEnabled') -ne 'true' -and $_.GetAttribute('scheme') -ne 'https' } | Select-Object -First 1
if (!$http) { throw 'Tomcat template has no HTTP connector.' }
foreach ($connector in $connectors) { if ($connector -ne $http) { $connector.ParentNode.RemoveChild($connector) | Out-Null } }
$http.SetAttribute('port', [string]$Port)
$http.SetAttribute('address', '127.0.0.1')
$http.SetAttribute('redirectPort', '0')
foreach ($engine in $server.SelectNodes('//Engine')) { $engine.SetAttribute('jvmRoute', 'rex-' + [IO.Path]::GetFileName($runtimePath)) }
foreach ($hostNode in $server.SelectNodes('//Host')) {
  $hostNode.SetAttribute('appBase', (Join-Path $runtimePath 'webapps'))
  $hostNode.SetAttribute('autoDeploy', 'false')
  $hostNode.SetAttribute('deployOnStartup', 'true')
}
foreach ($contextNode in $server.SelectNodes('//Context')) { $contextNode.SetAttribute('docBase', $sourceRoot) }
$server.Save($serverFile)
$rootFile = Join-Path $templatePath 'conf/Catalina/localhost/ROOT.xml'
$context = New-Object System.Xml.XmlDocument
$context.XmlResolver = $null
if (Test-Path -LiteralPath $rootFile) { $context.Load($rootFile) } else { $context.LoadXml('<Context/>') }
$context.DocumentElement.SetAttribute('docBase', $sourceRoot)
$context.DocumentElement.SetAttribute('reloadable', 'false')
$context.Save((Join-Path $runtimePath 'conf/Catalina/localhost/ROOT.xml'))
Write-Output "Isolated Flow preview: http://127.0.0.1:$Port/"
Write-Output "Tomcat base: $runtimePath"
Write-Output "Source: $sourceRoot"
Write-Output 'JPDA, AJP, and shutdown listeners: disabled'
if ($PrepareOnly) { exit 0 }
$env:JAVA_HOME = $JavaHome
$env:CATALINA_HOME = $CatalinaHome
$env:CATALINA_BASE = $runtimePath
$javaArgs = @(
  '-DJEX_CONNAME=CONTENT', '-Duser.language=en', '-Duser.region=us', '-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8',
  '-Xms128m', "-Xmx${MaxHeapMb}m", "-DJEX_HOME=$(Join-Path $sourceRoot 'WEB-INF/jex')",
  "-Dcatalina.home=$CatalinaHome", "-Dcatalina.base=$runtimePath", "-Djava.io.tmpdir=$(Join-Path $runtimePath 'temp')",
  "-Djava.util.logging.config.file=$(Join-Path $runtimePath 'conf/logging.properties')",
  '-Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager', '-Djava.protocol.handler.pkgs=org.apache.catalina.webresources',
  '-classpath', "$bootstrap;$(Join-Path $CatalinaHome 'bin/tomcat-juli.jar')", 'org.apache.catalina.startup.Bootstrap', 'start'
)
& $java @javaArgs
exit $LASTEXITCODE

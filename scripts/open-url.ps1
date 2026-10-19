param([string]$Url)
$uri = [uri]$Url
if ($uri.Scheme -notin @('http','https') -or $uri.UserInfo) { throw 'Invalid website URL.' }
Start-Process -FilePath $uri.AbsoluteUri

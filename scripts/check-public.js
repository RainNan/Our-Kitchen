import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, sourceFiles, repositoryBoundary } from './launcher/core.js'
export async function checkPublic(base = root, checkBoundary = true) {
  if (checkBoundary) await repositoryBoundary(base)
  const findings = []
  for (const file of await sourceFiles(base)) {
    if (!/\.(?:js|json|ps1|html|vue|md|yaml|sh|py|bat|example)$/.test(file)) continue
    const text = await readFile(path.join(base, file), 'utf8')
    if (/scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|SCT[a-zA-Z0-9]{24,}|sctp\d+t[a-zA-Z0-9]{24,}|[A-Z]:[\\/]Users[\\/][^\s/\\]+/i.test(text)) findings.push(file)
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (!/^(127\.|0\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|255\.)/.test(match[0])) findings.push(file)
    }
  }
  if (findings.length) throw new Error('发现可能的私密信息，请检查文件：' + [...new Set(findings)].join('、'))
  return (await sourceFiles(base)).length
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`开源检查通过：${await checkPublic()}个发布文件；未执行提交或推送。`) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

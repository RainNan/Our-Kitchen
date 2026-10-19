import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

// Local, optimized demo assets from an Unlicense cookbook. Never hotlink private menu photos.
const assets = {
  ribs: 'dishes/meat_dish/糖醋排骨/2.jpeg',
  pork: 'dishes/meat_dish/红烧肉/000.jpg',
  shrimp: 'dishes/aquatic/蒜香黄油虾/1.jpg',
  tofu: 'dishes/meat_dish/麻婆豆腐/1.jpeg',
  soup: 'dishes/soup/玉米排骨汤/玉米排骨汤.jpeg',
  wings: 'dishes/semi-finished/空气炸锅鸡翅中/鸡翅中_1.jpg',
  cake: 'dishes/dessert/烤箱版巴斯克芝士蛋糕/烤箱版巴斯克芝士蛋糕.jpg',
  drink: 'dishes/drink/百香果橙子特调/soda-version.jpg',
}
const commitResponse = await fetch('https://api.github.com/repos/Anduin2017/HowToCook/commits/master', { headers: { 'User-Agent': 'our-kitchen' }, signal: AbortSignal.timeout(30000) })
if (!commitResponse.ok) throw new Error('Could not pin asset commit')
const { sha } = await commitResponse.json()
await mkdir('seed-assets', { recursive: true })
const manifest = { repo: 'Anduin2017/HowToCook', license: 'Unlicense', commit: sha, assets: {} }
await Promise.all(Object.entries(assets).map(async ([name, source]) => {
  const url = `https://raw.githubusercontent.com/Anduin2017/HowToCook/${sha}/${source.split('/').map(encodeURIComponent).join('/')}`
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) })
      if (!response.ok) throw new Error(`Could not load ${name}`)
      const image = await sharp(Buffer.from(await response.arrayBuffer())).rotate().resize(1000, 1000, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
      await writeFile(`seed-assets/${name}.webp`, image)
      manifest.assets[`${name}.webp`] = { source, url }
      console.log(`Saved ${name}.webp`)
      return
    } catch (error) { lastError = error }
  }
  throw lastError
}))
await writeFile('seed-assets/SOURCES.json', JSON.stringify(manifest, null, 2) + '\n')

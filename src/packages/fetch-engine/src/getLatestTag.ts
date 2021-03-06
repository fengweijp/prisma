import fetch from 'node-fetch'
import { getProxyAgent } from './getProxyAgent'
import { getDownloadUrl } from './util'
import { platforms } from '@prisma/get-platform'
import PQueue from 'p-queue'

export async function getLatestTag(): Promise<any> {
  const url = `https://api.github.com/repos/prisma/prisma-engines/commits`
  const result = await fetch(url, {
    agent: getProxyAgent(url),
  } as any).then((res) => res.json())
  const commits = result.map((r) => r.sha)
  const commit = await getFirstExistingCommit(commits)
  const queue = new PQueue({ concurrency: 30 })
  const promises = []
  const excludedPlatforms = [
    'freebsd',
    'arm',
    'linux-nixos',
    'openbsd',
    'netbsd',
  ]
  const relevantPlatforms = platforms.filter(
    (p) => !excludedPlatforms.includes(p),
  )
  for (const platform of relevantPlatforms) {
    for (const engine of [
      'query-engine',
      'introspection-engine',
      'migration-engine',
      'prisma-fmt',
    ]) {
      for (const extension of [
        '.gz',
        '.gz.sha256',
        '.gz.sig',
        '.sig',
        '.sha256',
      ]) {
        const downloadUrl = getDownloadUrl(
          'master',
          commit,
          platform,
          engine,
          extension,
        )
        promises.push(
          queue.add(async () => ({
            downloadUrl,
            exists: await urlExists(downloadUrl),
          })),
        )
      }
    }
  }

  // wait for all queue items to finish
  const exist: Array<{
    downloadUrl: string
    exists: boolean
  }> = await Promise.all(promises)

  const missing = exist.filter((e) => !e.exists)
  if (missing.length > 0) {
    throw new Error(
      `Could not get new tag, as some assets don't exist: ${missing
        .map((m) => m.downloadUrl)
        .join(', ')}`,
    )
  }

  return commit
}

async function getFirstExistingCommit(commits: string[]): Promise<string> {
  for (const commit of commits) {
    const exists = await urlExists(
      getDownloadUrl('master', commit, 'darwin', 'query-engine'),
    )
    if (exists) {
      return commit
    }
  }
}

async function urlExists(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      agent: getProxyAgent(url),
    })

    const headers = fromEntries(res.headers.entries())
    if (res.status > 200) {
      console.error(res, headers)
    }
    if (parseInt(headers['content-length']) > 0) {
      return res.status < 300
    }
  } catch (e) {
    //
    console.error(e)
  }
  return false
}

function fromEntries<T>(
  entries: IterableIterator<[string, T]>,
): Record<string, T> {
  const result = {}
  for (const [key, value] of entries) {
    result[key] = value
  }
  return result
}

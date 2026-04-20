const GITHUB_REPO = 'vercel-labs/coding-agent-template'
const CACHE_DURATION = 5 * 60 // 5 minutes in seconds
let lastGitHubStarsFailureLogAt = 0

function shouldLogGitHubStarsFailure(now: number): boolean {
  if (now - lastGitHubStarsFailureLogAt < CACHE_DURATION * 1000) {
    return false
  }

  lastGitHubStarsFailureLogAt = now
  return true
}

export async function getGitHubStars(): Promise<number> {
  const now = Date.now()

  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'coding-agent-template',
      },
      next: { revalidate: CACHE_DURATION },
    })

    if (!response.ok) {
      throw new Error('GitHub API request failed')
    }

    const data = await response.json()
    return data.stargazers_count || 1200
  } catch {
    if (shouldLogGitHubStarsFailure(now)) {
      console.warn('GitHub stars unavailable')
    }
    return 1200 // Fallback value
  }
}

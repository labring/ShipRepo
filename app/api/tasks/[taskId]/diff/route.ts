import { NextRequest, NextResponse } from 'next/server'
import { getOctokit } from '@/lib/github/client'
import { execInTaskWorkspace, getOwnedTask, toTaskRelativePath } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'
import type { Octokit } from '@octokit/rest'

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const langMap: { [key: string]: string } = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    sql: 'sql',
  }
  return langMap[ext || ''] || 'text'
}

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'tif']
  return imageExtensions.includes(ext || '')
}

function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  const binaryExtensions = [
    'zip',
    'tar',
    'gz',
    'rar',
    '7z',
    'bz2',
    'exe',
    'dll',
    'so',
    'dylib',
    'db',
    'sqlite',
    'sqlite3',
    'mp3',
    'mp4',
    'avi',
    'mov',
    'wav',
    'flac',
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'ttf',
    'otf',
    'woff',
    'woff2',
    'eot',
    'bin',
    'dat',
    'dmg',
    'iso',
    'img',
  ]
  return binaryExtensions.includes(ext || '') || isImageFile(filename)
}

async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  isImage: boolean,
): Promise<{ content: string; isBase64: boolean }> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    })

    if ('content' in response.data && typeof response.data.content === 'string') {
      if (isImage) {
        return {
          content: response.data.content,
          isBase64: true,
        }
      }

      return {
        content: Buffer.from(response.data.content, 'base64').toString('utf-8'),
        isBase64: false,
      }
    }

    return { content: '', isBase64: false }
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
      return { content: '', isBase64: false }
    }
    throw error
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const searchParams = request.nextUrl.searchParams
    const rawFilename = searchParams.get('filename')
    const mode = searchParams.get('mode')

    if (!rawFilename) {
      return NextResponse.json({ error: 'Missing filename parameter' }, { status: 400 })
    }

    const filename = decodeURIComponent(rawFilename)
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (!task.branchName || !task.repoUrl) {
      return NextResponse.json({ error: 'Task does not have branch or repository information' }, { status: 400 })
    }

    if (mode === 'local') {
      const relativeFilename = toTaskRelativePath(filename)
      const remoteRef = `origin/${task.branchName}`
      const compareRefResult = await execInTaskWorkspace(
        task,
        [
          `git fetch origin ${shellEscape(task.branchName)} >/dev/null 2>&1 || true`,
          `if git rev-parse --verify ${shellEscape(remoteRef)} >/dev/null 2>&1; then`,
          `  printf '%s\\n' ${shellEscape(remoteRef)}`,
          'else',
          `  printf '%s\\n' 'HEAD'`,
          'fi',
        ].join('\n'),
        { timeoutSeconds: 60 },
      )

      const compareRef = compareRefResult.result.stdout.trim() || 'HEAD'
      const oldContentResult = await execInTaskWorkspace(
        task,
        `git show ${shellEscape(`${compareRef}:${relativeFilename}`)} 2>/dev/null || true`,
        { timeoutSeconds: 30 },
      )
      const newContentResult = await execInTaskWorkspace(
        task,
        `cat ${shellEscape(relativeFilename)} 2>/dev/null || true`,
        {
          timeoutSeconds: 30,
        },
      )

      return NextResponse.json({
        success: true,
        data: {
          filename,
          oldContent: oldContentResult.result.stdout,
          newContent: newContentResult.result.stdout,
          language: getLanguageFromFilename(filename),
          isBinary: false,
          isImage: false,
        },
      })
    }

    const octokit = await getOctokit()
    if (!octokit.auth) {
      return NextResponse.json(
        {
          error: 'GitHub authentication required. Please connect your GitHub account to view file diffs.',
        },
        { status: 401 },
      )
    }

    const githubMatch = task.repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/)
    if (!githubMatch) {
      return NextResponse.json({ error: 'Invalid GitHub repository URL' }, { status: 400 })
    }

    const [, owner, repo] = githubMatch

    try {
      const isImage = isImageFile(filename)
      const isBinary = isBinaryFile(filename)

      if (isBinary && !isImage) {
        return NextResponse.json({
          success: true,
          data: {
            filename,
            oldContent: '',
            newContent: '',
            language: 'text',
            isBinary: true,
            isImage: false,
          },
        })
      }

      let oldContent = ''
      let newContent = ''
      let newIsBase64 = false
      let baseRef = 'main'
      let headRef = task.branchName

      if (task.prNumber) {
        try {
          const prResponse = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: task.prNumber,
          })

          baseRef = prResponse.data.base.sha
          headRef = prResponse.data.head.sha
        } catch (error) {
          console.error('Failed to fetch PR data for diff:', error)
        }
      }

      try {
        const result = await getFileContent(octokit, owner, repo, filename, baseRef, isImage)
        oldContent = result.content
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 404 && baseRef === 'main') {
          const fallback = await getFileContent(octokit, owner, repo, filename, 'master', isImage)
          oldContent = fallback.content
        } else if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) {
          throw error
        }
      }

      try {
        const result = await getFileContent(octokit, owner, repo, filename, headRef, isImage)
        newContent = result.content
        newIsBase64 = result.isBase64
      } catch (error) {
        if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) {
          throw error
        }
      }

      if (!oldContent && !newContent) {
        return NextResponse.json({ error: 'File not found in either branch' }, { status: 404 })
      }

      return NextResponse.json({
        success: true,
        data: {
          filename,
          oldContent,
          newContent,
          language: getLanguageFromFilename(filename),
          isBinary: false,
          isImage,
          isBase64: newIsBase64,
        },
      })
    } catch (error) {
      console.error('Error fetching file diff from GitHub:', error)
      return NextResponse.json({ error: 'Failed to fetch file content from GitHub' }, { status: 500 })
    }
  } catch (error) {
    console.error('Error in diff API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

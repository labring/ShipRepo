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

async function readRuntimeFile(
  task: NonNullable<Awaited<ReturnType<typeof getOwnedTask>>>,
  filename: string,
  isImage: boolean,
) {
  const relativeFilename = toTaskRelativePath(filename)
  const command = isImage
    ? `base64 ${shellEscape(relativeFilename)} 2>/dev/null || true`
    : `cat ${shellEscape(relativeFilename)} 2>/dev/null || true`
  const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 30 })
  return result.stdout
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
    const mode = searchParams.get('mode') || 'remote'

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

    const octokit = await getOctokit()
    if (!octokit.auth) {
      return NextResponse.json(
        {
          error: 'GitHub authentication required. Please connect your GitHub account to view files.',
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

      const isNodeModulesFile = filename.includes('/node_modules/')
      let oldContent = ''
      let newContent = ''
      let isBase64 = false
      let fileFound = false

      if (mode === 'local') {
        if (!isNodeModulesFile) {
          const remoteResult = await getFileContent(octokit, owner, repo, filename, task.branchName, isImage)
          oldContent = remoteResult.content
          isBase64 = remoteResult.isBase64
        }

        newContent = await readRuntimeFile(task, filename, isImage)
        fileFound = Boolean(newContent) || isImage

        if (!fileFound) {
          return NextResponse.json({ error: 'File not found in runtime' }, { status: 404 })
        }
      } else {
        let content = ''

        if (isNodeModulesFile) {
          content = await readRuntimeFile(task, filename, isImage)
          fileFound = Boolean(content)
        } else {
          const result = await getFileContent(octokit, owner, repo, filename, task.branchName, isImage)
          content = result.content
          isBase64 = result.isBase64
          fileFound = Boolean(content) || isImage
        }

        if (!fileFound && !isImage && !isNodeModulesFile) {
          content = await readRuntimeFile(task, filename, isImage)
          fileFound = Boolean(content)
        }

        if (!fileFound && !isImage) {
          return NextResponse.json({ error: 'File not found in branch' }, { status: 404 })
        }

        newContent = content
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
          isBase64,
        },
      })
    } catch (error) {
      console.error('Error fetching file content:', error)
      return NextResponse.json({ error: 'Failed to fetch file content' }, { status: 500 })
    }
  } catch (error) {
    console.error('Error in file-content API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

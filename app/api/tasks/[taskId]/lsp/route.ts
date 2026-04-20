import { NextRequest, NextResponse } from 'next/server'
import { execInTaskWorkspace, getOwnedTask } from '@/lib/devbox/task-compat'
import { getServerSession } from '@/lib/session/get-server-session'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { taskId } = await params
    const task = await getOwnedTask(taskId, session.user.id)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const body = await request.json()
    const { method, filename, position } = body
    const absoluteFilename = filename.startsWith('/') ? filename : `/${filename}`

    if (method !== 'textDocument/definition') {
      if (method === 'textDocument/hover') {
        return NextResponse.json({ hover: null })
      }

      if (method === 'textDocument/completion') {
        return NextResponse.json({ completions: [] })
      }

      return NextResponse.json({ error: 'Unsupported LSP method' }, { status: 400 })
    }

    const payload = Buffer.from(
      JSON.stringify({
        filename: absoluteFilename,
        line: position.line,
        character: position.character,
      }),
    ).toString('base64')

    const helperScript = `
import ts from 'typescript'
import fs from 'fs'
import path from 'path'

const payload = JSON.parse(Buffer.from('${payload}', 'base64').toString('utf8'))
const filename = payload.filename
const line = payload.line
const character = payload.character

let configPath = process.cwd()
while (configPath !== '/') {
  const tsconfigPath = path.join(configPath, 'tsconfig.json')
  if (fs.existsSync(tsconfigPath)) {
    break
  }
  configPath = path.dirname(configPath)
}

const tsconfigPath = path.join(configPath, 'tsconfig.json')
const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configPath)

const files = new Map()
const host = {
  getScriptFileNames: () => parsedConfig.fileNames,
  getScriptVersion: (fileName) => {
    const file = files.get(fileName)
    return file && file.version ? file.version.toString() : '0'
  },
  getScriptSnapshot: (fileName) => {
    if (!fs.existsSync(fileName)) return undefined
    const content = fs.readFileSync(fileName, 'utf8')
    return ts.ScriptSnapshot.fromString(content)
  },
  getCurrentDirectory: () => configPath,
  getCompilationSettings: () => parsedConfig.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
}

const service = ts.createLanguageService(host, ts.createDocumentRegistry())
const program = service.getProgram()
if (!program) {
  console.log(JSON.stringify({ definitions: [] }))
  process.exit(0)
}

const fullPath = path.resolve(configPath, filename.replace(/^\\/*/g, ''))
const sourceFile = program.getSourceFile(fullPath)
if (!sourceFile) {
  console.log(JSON.stringify({ definitions: [] }))
  process.exit(0)
}

const offset = ts.getPositionOfLineAndCharacter(sourceFile, line, character)
const definitions = service.getDefinitionAtPosition(fullPath, offset) || []

const results = definitions
  .map((def) => {
    const defSourceFile = program.getSourceFile(def.fileName)
    if (!defSourceFile) {
      return null
    }

    const start = ts.getLineAndCharacterOfPosition(defSourceFile, def.textSpan.start)
    const end = ts.getLineAndCharacterOfPosition(defSourceFile, def.textSpan.start + def.textSpan.length)

    return {
      uri: 'file://' + def.fileName,
      range: {
        start,
        end,
      },
    }
  })
  .filter(Boolean)

console.log(JSON.stringify({ definitions: results }))
`

    const encodedScript = Buffer.from(helperScript).toString('base64')
    const command = [
      `printf '%s' '${encodedScript}' | base64 -d > .lsp-helper.mjs`,
      'node .lsp-helper.mjs',
      'rm -f .lsp-helper.mjs',
    ].join('\n')

    const { result } = await execInTaskWorkspace(task, command, { timeoutSeconds: 60 })
    if (result.exitCode !== 0) {
      return NextResponse.json({ definitions: [], error: 'Script execution failed' })
    }

    try {
      return NextResponse.json(JSON.parse(result.stdout.trim()))
    } catch (error) {
      console.error('Failed to parse LSP result:', error)
      return NextResponse.json({ definitions: [], error: 'Failed to parse TypeScript response' })
    }
  } catch (error) {
    console.error('LSP request error:', error)
    return NextResponse.json({ error: 'Failed to process LSP request' }, { status: 500 })
  }
}

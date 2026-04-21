'use client'

import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, ArrowUp } from 'lucide-react'
import { useAtom } from 'jotai'
import { taskPromptAtom } from '@/lib/atoms/task'
import { githubReposAtomFamily } from '@/lib/atoms/github-cache'
import { cn } from '@/lib/utils'

interface GitHubRepo {
  name: string
  full_name: string
  description: string
  private: boolean
  clone_url: string
  language: string
}

interface TaskFormProps {
  onSubmit: (data: {
    prompt: string
    repoUrl: string
    selectedAgent: string
    selectedModel: string
    selectedModels?: string[]
    installDependencies: boolean
    maxDuration: number
    keepAlive: boolean
    enableBrowser: boolean
  }) => void
  isSubmitting: boolean
  isAuthenticated: boolean
  selectedOwner: string
  selectedRepo: string
  commandHeader?: React.ReactNode
  variant?: 'default' | 'command'
  commandDisabled?: boolean
  commandPlaceholder?: string
  commandHelperText?: string
  alwaysShowCommandHelper?: boolean
  initialInstallDependencies?: boolean
  initialMaxDuration?: number
  initialKeepAlive?: boolean
  initialEnableBrowser?: boolean
  maxSandboxDuration?: number
}

const FIXED_TASK_AGENT = 'codex'
const FIXED_TASK_MODEL = 'gpt-5.4'

export function TaskForm({
  onSubmit,
  isSubmitting,
  isAuthenticated,
  selectedOwner,
  selectedRepo,
  commandHeader,
  variant = 'default',
  commandDisabled = false,
  commandPlaceholder,
  commandHelperText,
  alwaysShowCommandHelper = false,
  initialMaxDuration = 300,
}: TaskFormProps) {
  const [prompt, setPrompt] = useAtom(taskPromptAtom)
  const [repos, setRepos] = useAtom(githubReposAtomFamily(selectedOwner))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasSelectedRepo = Boolean(selectedOwner && selectedRepo)
  const isCommandVariant = variant === 'command'
  const defaultCommand = 'Prepare this repo for Sealos with /sealos-deploy.'

  const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') {
      return
    }

    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

    if (!isMobile && !event.shiftKey) {
      event.preventDefault()
      if (!commandDisabled && (isCommandVariant || prompt.trim())) {
        event.currentTarget.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }
    }
  }

  useEffect(() => {
    if (commandDisabled || (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches)) {
      return
    }

    textareaRef.current?.focus()
  }, [commandDisabled])

  useEffect(() => {
    if (!selectedOwner) {
      setRepos(null)
      return
    }

    const fetchRepos = async () => {
      if (repos && repos.length > 0) {
        return
      }

      try {
        const response = await fetch(`/api/github/repos?owner=${selectedOwner}`)
        if (response.ok) {
          const reposList = (await response.json()) as GitHubRepo[]
          setRepos(reposList)
        }
      } catch (error) {
        console.error('Error fetching repositories:', error)
      }
    }

    void fetchRepos()
  }, [repos, selectedOwner, setRepos])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()

    if (commandDisabled) {
      return
    }

    const trimmedPrompt = prompt.trim()
    const effectivePrompt = trimmedPrompt || (isCommandVariant ? defaultCommand : '')

    if (!effectivePrompt) {
      return
    }

    const selectedRepoData = repos?.find((repo) => repo.name === selectedRepo)

    onSubmit({
      prompt: effectivePrompt,
      repoUrl: selectedRepoData?.clone_url || '',
      selectedAgent: FIXED_TASK_AGENT,
      selectedModel: FIXED_TASK_MODEL,
      installDependencies: false,
      maxDuration: initialMaxDuration,
      keepAlive: false,
      enableBrowser: false,
    })
  }

  const title = !isAuthenticated
    ? 'Sign In to Deploy on Sealos'
    : hasSelectedRepo
      ? 'Deploy Your Project to Sealos'
      : 'Choose a Repository to Deploy'

  const description = !isAuthenticated
    ? 'Sign in first, then choose a GitHub repository and tell Sealos how it should be analyzed, built, and deployed.'
    : hasSelectedRepo
      ? 'Tell Sealos what you want to do with this repository. A simple deployment request is enough.'
      : 'Connect GitHub if needed, choose a repository, then describe how Sealos should analyze, build, and deploy it.'

  const repoBannerText = hasSelectedRepo
    ? `${selectedOwner}/${selectedRepo}`
    : !isAuthenticated
      ? 'Sign in to choose a GitHub repository.'
      : 'Choose a GitHub repository from the header to begin.'

  const placeholder = isCommandVariant
    ? (commandPlaceholder ?? defaultCommand)
    : !isAuthenticated
      ? 'Sign in first. After that, choose a repository and describe the deployment task here.'
      : hasSelectedRepo
        ? 'For example: deploy this repository to Sealos.'
        : 'Choose a repository first. Then describe how Sealos should build and deploy it.'

  const helperText = isCommandVariant
    ? (commandHelperText ?? 'Enter to deploy. Shift+Enter for a new line.')
    : !isAuthenticated
      ? 'Start by signing in. After you pick a repository, you can describe the deployment task here.'
      : hasSelectedRepo
        ? ''
        : 'After you pick a repository, describe what Sealos should build and deploy.'
  const showCommandHelper =
    isCommandVariant && Boolean(helperText) && (alwaysShowCommandHelper || prompt.trim().length > 0 || isSubmitting)

  if (isCommandVariant) {
    return (
      <form onSubmit={handleSubmit} className="w-full max-w-3xl">
        <label htmlFor="prompt" className="sr-only">
          Deployment command
        </label>

        <div className="rounded-[28px] border border-border/70 bg-background/95 px-4 py-4 shadow-[0_20px_56px_-44px_rgba(0,0,0,0.45)] backdrop-blur sm:px-5 sm:py-5">
          <div className="mb-3">{commandHeader ?? <div className="sealos-meta-value">{repoBannerText}</div>}</div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Textarea
              ref={textareaRef}
              id="prompt"
              aria-label="Deployment command"
              placeholder={placeholder}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              disabled={isSubmitting || commandDisabled}
              required={false}
              rows={1}
              className={cn(
                'sealos-command-text h-[52px] min-h-[52px] max-h-[52px] w-full flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-[11px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[17px]',
                commandDisabled && 'cursor-not-allowed text-muted-foreground/90',
              )}
            />

            <Button
              type="submit"
              disabled={isSubmitting || commandDisabled}
              className="sealos-action-text h-11 rounded-full px-5 sm:flex-shrink-0"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <ArrowUp className="h-4 w-4" />
                  Deploy
                </>
              )}
            </Button>
          </div>

          {showCommandHelper ? <div className="sealos-helper mt-2">{helperText}</div> : null}
        </div>
      </form>
    )
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-8 text-center">
        <h1 className="sealos-section-title text-foreground sm:text-[2.4rem]">{title}</h1>
        <p className="sealos-body mx-auto mt-3">{description}</p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="overflow-hidden rounded-2xl border bg-background shadow-sm">
          <div className="sealos-meta-label border-b bg-muted/20 px-4 py-2.5">{repoBannerText}</div>

          <div className="bg-transparent">
            <Textarea
              ref={textareaRef}
              id="prompt"
              placeholder={placeholder}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              disabled={isSubmitting}
              required
              rows={4}
              className="sealos-command-text min-h-[140px] w-full resize-none border-0 bg-transparent px-4 py-4 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-base"
            />
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-3">
            {helperText ? <div className="sealos-helper">{helperText}</div> : <div />}

            <Button
              type="submit"
              disabled={isSubmitting || !prompt.trim()}
              className="sealos-action-text h-9 rounded-full px-3"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

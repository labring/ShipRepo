'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SharedHeader } from '@/components/shared-header'
import { RepoSelector } from '@/components/repo-selector'
import { TaskForm } from '@/components/task-form'
import { GitHubIcon } from '@/components/icons/github-icon'
import { useTasks } from '@/components/app-layout'
import { setSelectedOwner, setSelectedRepo } from '@/lib/utils/cookies'
import { redirectToSignIn } from '@/lib/session/redirect-to-sign-in'
import { getEnabledAuthProviders } from '@/lib/auth/providers'
import { taskPromptAtom } from '@/lib/atoms/task'
import { sessionAtom } from '@/lib/atoms/session'
import { githubConnectionAtom, githubConnectionInitializedAtom } from '@/lib/atoms/github-connection'
import type { Session } from '@/lib/session/types'

interface SealosHomePageContentProps {
  initialSelectedOwner?: string
  initialSelectedRepo?: string
  initialInstallDependencies?: boolean
  initialMaxDuration?: number
  initialKeepAlive?: boolean
  initialEnableBrowser?: boolean
  maxSandboxDuration?: number
  user?: Session['user'] | null
  initialStars?: number
}

export function SealosHomePageContent({
  initialSelectedOwner = '',
  initialSelectedRepo = '',
  initialMaxDuration = 300,
  maxSandboxDuration = 300,
  user = null,
  initialStars = 1200,
}: SealosHomePageContentProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [selectedOwner, setSelectedOwnerState] = useState(initialSelectedOwner)
  const [selectedRepo, setSelectedRepoState] = useState(initialSelectedRepo)
  const [showSignInDialog, setShowSignInDialog] = useState(false)
  const [loadingVercel, setLoadingVercel] = useState(false)
  const [loadingGitHub, setLoadingGitHub] = useState(false)
  const router = useRouter()
  const { refreshTasks, addTaskOptimistically } = useTasks()
  const setTaskPrompt = useSetAtom(taskPromptAtom)
  const session = useAtomValue(sessionAtom)
  const githubConnection = useAtomValue(githubConnectionAtom)
  const githubConnectionInitialized = useAtomValue(githubConnectionInitializedAtom)
  const isGitHubAuthUser = session.authProvider === 'github'
  const { github: hasGitHub, vercel: hasVercel } = getEnabledAuthProviders()

  const handleOwnerChange = (owner: string) => {
    setSelectedOwnerState(owner)
    setSelectedOwner(owner)
    if (selectedRepo) {
      setSelectedRepoState('')
      setSelectedRepo('')
    }
  }

  const handleRepoChange = (repo: string) => {
    setSelectedRepoState(repo)
    setSelectedRepo(repo)
  }

  const handleTaskSubmit = async (data: {
    prompt: string
    repoUrl: string
    selectedAgent: string
    selectedModel: string
    selectedModels?: string[]
    installDependencies: boolean
    maxDuration: number
    keepAlive: boolean
    enableBrowser: boolean
  }) => {
    if (!user) {
      setShowSignInDialog(true)
      return
    }

    if (!data.repoUrl) {
      toast.error('Please select a repository', {
        description: 'Choose a GitHub repository from the header before starting the task.',
      })
      return
    }

    setTaskPrompt('')
    setIsSubmitting(true)

    const { id } = addTaskOptimistically(data)
    router.push(`/tasks/${id}`)

    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...data, id }),
      })

      if (response.ok) {
        toast.success('Task created successfully')
      } else {
        const error = await response.json()
        toast.error(error.message || error.error || 'Failed to create task')
      }

      await refreshTasks()
    } catch (error) {
      console.error('Error creating task:', error)
      toast.error('Failed to create task')
      await refreshTasks()
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleVercelSignIn = async () => {
    setLoadingVercel(true)
    await redirectToSignIn()
  }

  const handleGitHubSignIn = () => {
    setLoadingGitHub(true)
    window.location.href = '/api/auth/signin/github'
  }

  const handleConnectGitHub = () => {
    window.location.href = '/api/auth/github/signin'
  }

  const headerLeftActions = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {!githubConnectionInitialized ? null : githubConnection.connected ||
        isGitHubAuthUser ||
        selectedOwner ||
        selectedRepo ? (
        <RepoSelector
          selectedOwner={selectedOwner}
          selectedRepo={selectedRepo}
          onOwnerChange={handleOwnerChange}
          onRepoChange={handleRepoChange}
          size="sm"
        />
      ) : user ? (
        <Button onClick={handleConnectGitHub} variant="outline" size="sm" className="h-8 flex-shrink-0">
          <GitHubIcon className="mr-2 h-4 w-4" />
          Connect GitHub
        </Button>
      ) : null}
    </div>
  )

  return (
    <div className="flex flex-1 flex-col bg-background">
      <div className="p-3">
        <SharedHeader leftActions={headerLeftActions} initialStars={initialStars} />
      </div>

      <div className="flex flex-1 items-center justify-center px-4 pb-8">
        <TaskForm
          onSubmit={handleTaskSubmit}
          isSubmitting={isSubmitting}
          selectedOwner={selectedOwner}
          selectedRepo={selectedRepo}
          initialMaxDuration={initialMaxDuration}
          maxSandboxDuration={maxSandboxDuration}
        />
      </div>

      <Dialog open={showSignInDialog} onOpenChange={setShowSignInDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in to continue</DialogTitle>
            <DialogDescription>
              {hasGitHub && hasVercel
                ? 'You need to sign in to create tasks. Choose how you want to sign in.'
                : hasVercel
                  ? 'You need to sign in with Vercel to create tasks.'
                  : 'You need to sign in with GitHub to create tasks.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-4">
            {hasVercel && (
              <Button
                onClick={handleVercelSignIn}
                disabled={loadingVercel || loadingGitHub}
                variant="outline"
                size="lg"
                className="w-full"
              >
                {loadingVercel ? (
                  <>
                    <svg
                      className="mr-2 -ml-1 h-4 w-4 animate-spin"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4Z"
                      />
                    </svg>
                    Signing in with Vercel...
                  </>
                ) : (
                  'Sign in with Vercel'
                )}
              </Button>
            )}

            {hasGitHub && (
              <Button
                onClick={handleGitHubSignIn}
                disabled={loadingVercel || loadingGitHub}
                variant="outline"
                size="lg"
                className="w-full"
              >
                {loadingGitHub ? (
                  <>
                    <svg
                      className="mr-2 -ml-1 h-4 w-4 animate-spin"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4Z"
                      />
                    </svg>
                    Signing in with GitHub...
                  </>
                ) : (
                  <>
                    <GitHubIcon className="mr-2 h-4 w-4" />
                    Sign in with GitHub
                  </>
                )}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

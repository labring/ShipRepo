'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GitHubIcon } from '@/components/icons/github-icon'
import { useState } from 'react'
import { GitHubPopupAuthError, startGitHubPopupAuth } from '@/lib/auth/github-popup'
import { toast } from 'sonner'

export function SignIn() {
  const [showDialog, setShowDialog] = useState(false)
  const [loadingGitHub, setLoadingGitHub] = useState(false)

  const handleGitHubSignIn = async () => {
    setLoadingGitHub(true)
    try {
      await startGitHubPopupAuth('/api/auth/signin/github')
      window.location.reload()
    } catch (error) {
      if (error instanceof GitHubPopupAuthError && error.code === 'popup_blocked') {
        toast.error('Please allow popups and try again.')
      } else {
        toast.error('GitHub authentication failed. Please try again.')
      }
      setLoadingGitHub(false)
    }
  }

  return (
    <>
      <Button onClick={() => setShowDialog(true)} variant="outline" size="sm">
        Sign in
      </Button>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in</DialogTitle>
            <DialogDescription>Sign in with GitHub to continue.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-4">
            <Button
              onClick={handleGitHubSignIn}
              disabled={loadingGitHub}
              variant="outline"
              size="lg"
              className="w-full"
            >
              {loadingGitHub ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Loading...
                </>
              ) : (
                <>
                  <GitHubIcon className="h-4 w-4 mr-2" />
                  Sign in with GitHub
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

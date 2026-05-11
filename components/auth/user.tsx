'use client'

import { SignOut } from './sign-out'
import { SignIn } from './sign-in'
import { type Session } from '@/lib/session/types'
import { useAtomValue } from 'jotai'
import { sessionAtom, sessionInitializedAtom } from '@/lib/atoms/session'
import { useMemo } from 'react'

export function User(props: { user?: Session['user'] | null }) {
  const session = useAtomValue(sessionAtom)
  const initialized = useAtomValue(sessionInitializedAtom)

  // Use session values if initialized, otherwise use props
  const user = useMemo(
    () => (initialized ? (session.user ?? null) : (props.user ?? null)),
    [initialized, session.user, props.user],
  )

  if (user) {
    return <SignOut user={user} />
  } else {
    return <SignIn />
  }
}

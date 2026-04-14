import { NextResponse } from 'next/server'
import { DevboxApiError, getDevboxHealth } from '@/lib/devbox/client'

export async function GET() {
  try {
    const response = await getDevboxHealth()

    return NextResponse.json({
      success: true,
      data: response.data,
    })
  } catch (error) {
    if (error instanceof DevboxApiError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Devbox service is unavailable',
          statusCode: error.status,
        },
        { status: 502 },
      )
    }

    console.error('Failed to check Devbox health:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to check Devbox health',
      },
      { status: 500 },
    )
  }
}

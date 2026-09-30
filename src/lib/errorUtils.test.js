import { describe, it, expect } from 'vitest'
import { formatErrorMessage } from './errorUtils'

describe('formatErrorMessage', () => {
  it('returns fallback for null or undefined', () => {
    expect(formatErrorMessage(null)).toBe('An unexpected error occurred. Please try again.')
    expect(formatErrorMessage(undefined, 'Custom fallback')).toBe('Custom fallback')
  })

  it('returns clean string messages', () => {
    expect(formatErrorMessage('Invalid email address')).toBe('Invalid email address')
  })

  it('rejects literal "[object Object]" and returns fallback', () => {
    expect(formatErrorMessage('[object Object]')).toBe('An unexpected error occurred. Please try again.')
  })

  it('handles Vercel 404 error payload: { error: { code: "404", message: "The page could not be found" } }', () => {
    const vercelError = {
      error: {
        code: '404',
        message: 'The page could not be found',
      },
    }
    expect(formatErrorMessage(vercelError)).toBe('The page could not be found')
  })

  it('extracts message from ApiError or error.data.error', () => {
    const apiErr = {
      message: 'Request failed with status 400',
      data: { error: 'Email already registered' },
    }
    expect(formatErrorMessage(apiErr)).toBe('Email already registered')
  })

  it('extracts message from response.data.error.message', () => {
    const nestedErr = {
      response: {
        data: {
          error: {
            message: 'Database connection refused',
          },
        },
      },
    }
    expect(formatErrorMessage(nestedErr)).toBe('Database connection refused')
  })

  it('extracts message from standard Error instance', () => {
    const err = new Error('Network timeout')
    expect(formatErrorMessage(err)).toBe('Network timeout')
  })
})

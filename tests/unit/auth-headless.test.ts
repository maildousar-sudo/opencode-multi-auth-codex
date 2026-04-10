import { parseAuthorizationCallbackUrl } from '../../src/auth.js'

describe('Headless auth callback parsing', () => {
  it('extracts the authorization code from a callback URL', () => {
    const code = parseAuthorizationCallbackUrl(
      'http://localhost:1455/auth/callback?code=test-code&state=test-state',
      'test-state'
    )

    expect(code).toBe('test-code')
  })

  it('rejects callback URLs without an authorization code', () => {
    expect(() => {
      parseAuthorizationCallbackUrl(
        'http://localhost:1455/auth/callback?state=test-state',
        'test-state'
      )
    }).toThrow('Invalid callback URL: missing authorization code')
  })

  it('rejects callback URLs with a mismatched state', () => {
    expect(() => {
      parseAuthorizationCallbackUrl(
        'http://localhost:1455/auth/callback?code=test-code&state=wrong-state',
        'test-state'
      )
    }).toThrow('Invalid state')
  })

  it('surfaces provider errors from the callback URL', () => {
    expect(() => {
      parseAuthorizationCallbackUrl(
        'http://localhost:1455/auth/callback?error=access_denied&error_description=User%20cancelled',
        'test-state'
      )
    }).toThrow('Authorization failed: User cancelled')
  })
})

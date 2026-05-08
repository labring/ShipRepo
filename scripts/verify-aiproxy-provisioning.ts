import assert from 'node:assert/strict'
import { AIPROXY_AUTO_TOKEN_NAME, AIPROXY_MODEL_BASE_URL } from '@/lib/aiproxy/constants'
import { getAiProxyProvisioningTask, resetAiProxyProvisioningTaskForTests } from '@/lib/aiproxy/client-provisioning'
import { diagnoseAiProxyTokenInfo, isUsableAiProxyTokenInfo } from '@/lib/aiproxy/token-validation'

async function testGatewayBaseUrlUsesOpenAiPath() {
  assert.equal(AIPROXY_MODEL_BASE_URL, 'https://aiproxy.usw-1.sealos.io/v1')
}

async function testTokenValidationRejectsWrongName() {
  assert.equal(
    diagnoseAiProxyTokenInfo({
      expired_at: -1,
      id: 1,
      key: 'sk-1234567890',
      name: 'other',
      status: 1,
    }),
    'wrong_name',
  )

  assert.equal(
    isUsableAiProxyTokenInfo({
      id: 1,
      key: 'sk-1234567890',
      name: 'other',
      status: 1,
    }),
    false,
  )
}

async function testTokenValidationIgnoresExpirationField() {
  assert.equal(
    diagnoseAiProxyTokenInfo({
      expired_at: 10,
      id: 1,
      key: 'sk-1234567890',
      name: AIPROXY_AUTO_TOKEN_NAME,
      status: 1,
    }),
    null,
  )

  assert.equal(
    isUsableAiProxyTokenInfo({
      id: 1,
      key: 'sk-1234567890',
      name: AIPROXY_AUTO_TOKEN_NAME,
      status: 1,
    }),
    true,
  )
}

async function testTokenValidationAcceptsUsableToken() {
  assert.equal(
    diagnoseAiProxyTokenInfo({
      expired_at: -1,
      id: 1,
      key: 'sk-1234567890',
      name: AIPROXY_AUTO_TOKEN_NAME,
      status: 1,
    }),
    null,
  )

  assert.equal(
    isUsableAiProxyTokenInfo({
      id: 1,
      key: 'sk-1234567890',
      name: AIPROXY_AUTO_TOKEN_NAME,
      status: 1,
    }),
    true,
  )
}

async function testTokenValidationReportsMissingExpiration() {
  assert.equal(
    diagnoseAiProxyTokenInfo({
      id: 1,
      key: 'sk-1234567890',
      name: AIPROXY_AUTO_TOKEN_NAME,
      status: 1,
    }),
    null,
  )

  assert.equal(
    isUsableAiProxyTokenInfo({
      id: 1,
      key: 'sk-1234567890',
      name: AIPROXY_AUTO_TOKEN_NAME,
      status: 1,
    }),
    true,
  )
}

async function testClientProvisioningReusesInflightRequest() {
  resetAiProxyProvisioningTaskForTests()

  let callCount = 0
  const runProvisioning = async () => {
    callCount += 1
    await Promise.resolve()
    return true
  }

  const first = getAiProxyProvisioningTask(runProvisioning)
  const second = getAiProxyProvisioningTask(runProvisioning)

  assert.equal(first, second)
  assert.equal(await first, true)
  assert.equal(callCount, 1)
}

async function testClientProvisioningRetriesAfterFailure() {
  resetAiProxyProvisioningTaskForTests()

  let callCount = 0
  const failing = async () => {
    callCount += 1
    return false
  }

  assert.equal(await getAiProxyProvisioningTask(failing), false)
  assert.equal(await getAiProxyProvisioningTask(failing), false)
  assert.equal(callCount, 2)
}

async function main() {
  await testGatewayBaseUrlUsesOpenAiPath()
  await testTokenValidationRejectsWrongName()
  await testTokenValidationIgnoresExpirationField()
  await testTokenValidationAcceptsUsableToken()
  await testTokenValidationReportsMissingExpiration()
  await testClientProvisioningReusesInflightRequest()
  await testClientProvisioningRetriesAfterFailure()
  console.info('AIProxy provisioning verification passed')
}

main().catch(() => {
  console.error('AIProxy provisioning verification failed')
  process.exitCode = 1
})

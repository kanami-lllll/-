import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8098';
const ACTIVITY_ID = Number(__ENV.ACTIVITY_ID || 100401);
const SKU = Number(__ENV.SKU || 9901);
const USER_COUNT = Number(__ENV.USER_COUNT || 200);
const DRAW_VUS = Number(__ENV.DRAW_VUS || 50);
const DRAW_ITERATIONS = Number(__ENV.DRAW_ITERATIONS || USER_COUNT);
const SIGN_WAIT_SECONDS = Number(__ENV.SIGN_WAIT_SECONDS || 5);
const EXCHANGE_WAIT_SECONDS = Number(__ENV.EXCHANGE_WAIT_SECONDS || 5);
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;
const DEBUG = (__ENV.DEBUG || 'false').toLowerCase() === 'true';

const drawSuccessRate = new Rate('draw_success_rate');
const drawReqDuration = new Trend('draw_req_duration');
const drawRequests = new Counter('draw_requests');
const drawBusinessFailures = new Counter('draw_business_failures');

export const options = {
  setupTimeout: '30m',
  scenarios: {
    draw_peak: {
      executor: 'shared-iterations',
      vus: DRAW_VUS,
      iterations: DRAW_ITERATIONS,
      maxDuration: '10m',
    },
  },
  thresholds: {
    draw_success_rate: ['rate>0.95'],
    draw_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.05'],
  },
};

const jsonHeaders = {
  'Content-Type': 'application/json;charset=utf-8',
};

const formHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded',
};

function buildUserId(index) {
  return `guest_k6_draw_load_${RUN_ID}_${index}`;
}

function businessCode(response) {
  try {
    return response.json('code');
  } catch (e) {
    return undefined;
  }
}

function postSign(userId) {
  return http.post(
    `${BASE_URL}/api/v1/raffle/activity/calendar_sign_rebate`,
    `userId=${encodeURIComponent(userId)}`,
    { headers: formHeaders, tags: { phase: 'setup', api: 'calendar_sign_rebate' } }
  );
}

function postExchange(userId) {
  return http.post(
    `${BASE_URL}/api/v1/raffle/activity/credit_pay_exchange_sku`,
    JSON.stringify({ userId, sku: SKU }),
    { headers: jsonHeaders, tags: { phase: 'setup', api: 'credit_pay_exchange_sku' } }
  );
}

function postQueryAccount(userId) {
  return http.post(
    `${BASE_URL}/api/v1/raffle/activity/query_user_activity_account`,
    JSON.stringify({ userId, activityId: ACTIVITY_ID }),
    { headers: jsonHeaders, tags: { phase: 'setup', api: 'query_user_activity_account' } }
  );
}

export function setup() {
  const users = [];

  for (let i = 0; i < USER_COUNT; i += 1) {
    const userId = buildUserId(i);
    users.push(userId);

    const response = postSign(userId);
    const ok = response.status === 200 && businessCode(response) === '0000';
    if (DEBUG && !ok) {
      console.log(`sign failed userId=${userId} status=${response.status} body=${response.body}`);
    }
  }

  sleep(SIGN_WAIT_SECONDS);

  for (const userId of users) {
    const response = postExchange(userId);
    const ok = response.status === 200 && businessCode(response) === '0000';
    if (DEBUG && !ok) {
      console.log(`exchange failed userId=${userId} status=${response.status} body=${response.body}`);
    }
  }

  sleep(EXCHANGE_WAIT_SECONDS);

  const sampleCount = Math.min(3, users.length);
  for (let i = 0; i < sampleCount; i += 1) {
    const userId = users[i];
    const response = postQueryAccount(userId);
    if (DEBUG) {
      console.log(`account sample userId=${userId} status=${response.status} body=${response.body}`);
    }
  }

  return { users };
}

export default function (data) {
  const iterationIndex = exec.scenario.iterationInTest;
  const userId = data.users[iterationIndex % data.users.length];

  const response = http.post(
    `${BASE_URL}/api/v1/raffle/activity/draw`,
    JSON.stringify({ userId, activityId: ACTIVITY_ID }),
    { headers: jsonHeaders, tags: { phase: 'load', api: 'draw' } }
  );

  drawRequests.add(1);
  drawReqDuration.add(response.timings.duration);

  const ok = response.status === 200 && businessCode(response) === '0000';
  drawSuccessRate.add(ok);
  if (!ok) {
    drawBusinessFailures.add(1);
  }

  if (DEBUG && !ok) {
    console.log(`draw failed userId=${userId} status=${response.status} body=${response.body}`);
  }

  check(response, {
    'draw HTTP status is 200': (res) => res.status === 200,
    'draw business code is 0000': (res) => businessCode(res) === '0000',
  });
}

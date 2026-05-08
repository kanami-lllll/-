import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8098';
const ACTIVITY_ID = Number(__ENV.ACTIVITY_ID || 100401);
const SKU = Number(__ENV.SKU || 9901);
const USER_COUNT = Number(__ENV.USER_COUNT || 1000);
const TARGET_RPS = Number(__ENV.TARGET_RPS || 50);
const DURATION = __ENV.DURATION || '1m';
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || TARGET_RPS);
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(TARGET_RPS * 2, PRE_ALLOCATED_VUS));
const SIGN_WAIT_SECONDS = Number(__ENV.SIGN_WAIT_SECONDS || 15);
const EXCHANGE_WAIT_SECONDS = Number(__ENV.EXCHANGE_WAIT_SECONDS || 15);
const READY_CHECK_RETRIES = Number(__ENV.READY_CHECK_RETRIES || 3);
const READY_CHECK_INTERVAL_SECONDS = Number(__ENV.READY_CHECK_INTERVAL_SECONDS || 10);
const EXCHANGE_RETRIES = Number(__ENV.EXCHANGE_RETRIES || 2);
const EXCHANGE_RETRY_WAIT_SECONDS = Number(__ENV.EXCHANGE_RETRY_WAIT_SECONDS || 10);
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;
const DEBUG = (__ENV.DEBUG || 'false').toLowerCase() === 'true';

const drawSuccessRate = new Rate('draw_success_rate');
const drawReqDuration = new Trend('draw_req_duration');
const drawRequests = new Counter('draw_requests');
const drawBusinessFailures = new Counter('draw_business_failures');

export const options = {
  setupTimeout: '60m',
  scenarios: {
    draw_constant_rps: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    draw_success_rate: ['rate>0.99'],
    draw_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

const jsonHeaders = {
  'Content-Type': 'application/json;charset=utf-8',
};

const formHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded',
};

function buildUserId(index) {
  return `guest_k6_draw_rps_${RUN_ID}_${index}`;
}

function businessCode(response) {
  try {
    return response.json('code');
  } catch (e) {
    return undefined;
  }
}

function durationToSeconds(duration) {
  const match = String(duration).trim().match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    throw new Error(`Unsupported DURATION format: ${duration}. Use values like 30s, 1m, or 2m.`);
  }

  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'ms') return value / 1000;
  if (unit === 's') return value;
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 60 * 60;
  throw new Error(`Unsupported DURATION unit: ${unit}`);
}

function hasDrawQuota(response) {
  try {
    const data = response.json('data');
    return data
      && Number(data.totalCountSurplus) > 0
      && Number(data.dayCountSurplus) > 0
      && Number(data.monthCountSurplus) > 0;
  } catch (e) {
    return false;
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
  const requiredDraws = Math.ceil(TARGET_RPS * durationToSeconds(DURATION));

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

  const readyMap = {};
  let readyUsers = [];

  for (let retry = 0; retry < READY_CHECK_RETRIES; retry += 1) {
    readyUsers = [];

    for (const userId of users) {
      if (readyMap[userId]) {
        readyUsers.push(userId);
        continue;
      }

      const response = postQueryAccount(userId);
      if (hasDrawQuota(response)) {
        readyMap[userId] = true;
        readyUsers.push(userId);
      } else if (DEBUG && retry === READY_CHECK_RETRIES - 1) {
        console.log(`account not ready userId=${userId} status=${response.status} body=${response.body}`);
      }
    }

    console.log(`setup ready check ${retry + 1}/${READY_CHECK_RETRIES}: readyUsers=${readyUsers.length}, requiredDraws=${requiredDraws}`);
    if (readyUsers.length >= requiredDraws) {
      break;
    }

    if (retry < READY_CHECK_RETRIES - 1) {
      sleep(READY_CHECK_INTERVAL_SECONDS);
    }
  }

  for (let retry = 0; readyUsers.length < requiredDraws && retry < EXCHANGE_RETRIES; retry += 1) {
    const notReadyUsers = users.filter((userId) => !readyMap[userId]);
    console.log(`setup retry exchange ${retry + 1}/${EXCHANGE_RETRIES}: notReadyUsers=${notReadyUsers.length}`);

    for (const userId of notReadyUsers) {
      const response = postExchange(userId);
      const ok = response.status === 200 && businessCode(response) === '0000';
      if (DEBUG && !ok) {
        console.log(`retry exchange failed userId=${userId} status=${response.status} body=${response.body}`);
      }
    }

    sleep(EXCHANGE_RETRY_WAIT_SECONDS);
    readyUsers = [];

    for (const userId of users) {
      if (readyMap[userId]) {
        readyUsers.push(userId);
        continue;
      }

      const response = postQueryAccount(userId);
      if (hasDrawQuota(response)) {
        readyMap[userId] = true;
        readyUsers.push(userId);
      } else if (DEBUG && retry === EXCHANGE_RETRIES - 1) {
        console.log(`account still not ready userId=${userId} status=${response.status} body=${response.body}`);
      }
    }

    console.log(`setup retry exchange result ${retry + 1}/${EXCHANGE_RETRIES}: readyUsers=${readyUsers.length}, requiredDraws=${requiredDraws}`);
  }

  if (readyUsers.length < requiredDraws) {
    throw new Error(`Not enough ready users for draw load test. readyUsers=${readyUsers.length}, requiredDraws=${requiredDraws}. Check sign/exchange/account quota setup before running RPS test.`);
  }

  console.log(`setup completed: using readyUsers=${readyUsers.length}, requiredDraws=${requiredDraws}`);
  return { users: readyUsers };
}

export default function (data) {
  const iterationIndex = exec.scenario.iterationInTest;
  if (iterationIndex >= data.users.length) {
    drawSuccessRate.add(false);
    drawBusinessFailures.add(1);
    return;
  }

  const userId = data.users[iterationIndex];
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

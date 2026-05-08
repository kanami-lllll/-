import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8098';
const ACTIVITY_ID = Number(__ENV.ACTIVITY_ID || 100401);
const USER_COUNT = Number(__ENV.USER_COUNT || 20);
const DRAW_VUS = Number(__ENV.DRAW_VUS || 10);
const PREP_WAIT_SECONDS = Number(__ENV.PREP_WAIT_SECONDS || 10);
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;
const DEBUG = (__ENV.DEBUG || 'false').toLowerCase() === 'true';
const VERIFY_ACCOUNT = (__ENV.VERIFY_ACCOUNT || 'true').toLowerCase() === 'true';

export const options = {
  setupTimeout: '3m',
  scenarios: {
    draw_once_per_user: {
      executor: 'shared-iterations',
      vus: DRAW_VUS,
      iterations: USER_COUNT,
      maxDuration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1500'],
    checks: ['rate>0.95'],
  },
};

const jsonHeaders = {
  'Content-Type': 'application/json',
};

const formHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded',
};

function buildUserId(index) {
  return `guest_k6_draw_${RUN_ID}_${index}`;
}

export function setup() {
  const users = [];

  for (let i = 0; i < USER_COUNT; i += 1) {
    const userId = buildUserId(i);
    users.push(userId);

    const response = http.post(
      `${BASE_URL}/api/v1/raffle/activity/calendar_sign_rebate`,
      `userId=${encodeURIComponent(userId)}`,
      { headers: formHeaders, tags: { api: 'calendar_sign_rebate' } }
    );

    if (DEBUG && response.json('code') !== '0000') {
      console.log(`prepare failed userId=${userId} status=${response.status} body=${response.body}`);
    }

    check(response, {
      'prepare sign HTTP status is 200': (res) => res.status === 200,
      'prepare sign business code is 0000': (res) => {
        try {
          return res.json('code') === '0000';
        } catch (e) {
          return false;
        }
      },
    });
  }

  sleep(PREP_WAIT_SECONDS);

  if (VERIFY_ACCOUNT) {
    for (const userId of users) {
      const payload = JSON.stringify({
        userId,
        activityId: ACTIVITY_ID,
      });

      const response = http.post(
        `${BASE_URL}/api/v1/raffle/activity/query_user_activity_account`,
        payload,
        { headers: jsonHeaders, tags: { api: 'query_user_activity_account' } }
      );

      if (DEBUG) {
        console.log(`account check userId=${userId} status=${response.status} body=${response.body}`);
      }
    }
  }

  return { users };
}

export default function (data) {
  const iterationIndex = exec.scenario.iterationInTest;
  const userId = data.users[iterationIndex % data.users.length];

  const payload = JSON.stringify({
    userId,
    activityId: ACTIVITY_ID,
  });

  const response = http.post(
    `${BASE_URL}/api/v1/raffle/activity/draw`,
    payload,
    { headers: jsonHeaders, tags: { api: 'draw' } }
  );

  if (DEBUG && response.json('code') !== '0000') {
    console.log(`draw failed userId=${userId} status=${response.status} body=${response.body}`);
  }

  check(response, {
    'draw HTTP status is 200': (res) => res.status === 200,
    'draw business code is 0000': (res) => {
      try {
        return res.json('code') === '0000';
      } catch (e) {
        return false;
      }
    },
    'draw has award data': (res) => {
      try {
        return Boolean(res.json('data.awardId'));
      } catch (e) {
        return false;
      }
    },
  });

  sleep(0.2);
}

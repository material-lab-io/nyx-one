#!/usr/bin/env node

/**
 * Simple Linear CLI for Nyx
 *
 * Usage:
 *   linear create "Task title" [--description "..."] [--priority 1-4]
 *   linear list [--status open|done|all] [--limit N]
 *   linear search "query" [--limit N]
 *   linear update ISSUE-ID [--status todo|in_progress|done] [--title "..."] [--team TEAM_KEY]
 *   linear get ISSUE-ID
 *
 * Environment:
 *   LINEAR_API_KEY  - Required
 *   LINEAR_TEAM_KEY - Optional (default: FB)
 */

import { LinearClient } from '@linear/sdk';

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error('Error: LINEAR_API_KEY environment variable required');
  process.exit(1);
}

const linear = new LinearClient({ apiKey });
const DEFAULT_TEAM = process.env.LINEAR_TEAM_KEY || 'FB';

async function getTeam(teamKey = DEFAULT_TEAM) {
  const teams = await linear.teams();
  const team = teams.nodes.find(t => t.key === teamKey);
  if (!team) throw new Error(`Team ${teamKey} not found`);
  return team;
}

async function createIssue(title, opts = {}) {
  const team = await getTeam(opts.team);

  const issueData = {
    title,
    teamId: team.id,
  };

  if (opts.description) issueData.description = opts.description;
  if (opts.priority) issueData.priority = parseInt(opts.priority);

  const result = await linear.createIssue(issueData);
  const issue = await result.issue;

  console.log(JSON.stringify({
    success: true,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url
  }, null, 2));
}

async function listIssues(opts = {}) {
  const team = await getTeam(opts.team);
  const limit = parseInt(opts.limit) || 20;
  const status = opts.status || 'open';

  const filter = {
    team: { id: { eq: team.id } }
  };

  if (status === 'open') {
    filter.state = { type: { nin: ['completed', 'canceled'] } };
  } else if (status === 'done') {
    filter.state = { type: { eq: 'completed' } };
  }

  const issues = await linear.issues({
    filter,
    first: limit,
    orderBy: 'updatedAt'
  });

  const result = issues.nodes.map(issue => ({
    identifier: issue.identifier,
    title: issue.title,
    priority: issue.priority,
    state: issue.state?.name
  }));

  console.log(JSON.stringify({ issues: result }, null, 2));
}

async function searchIssues(query, opts = {}) {
  const team = await getTeam(opts.team);
  const limit = parseInt(opts.limit) || 10;

  const issues = await linear.issues({
    filter: {
      team: { id: { eq: team.id } },
      or: [
        { title: { containsIgnoreCase: query } },
        { description: { containsIgnoreCase: query } }
      ]
    },
    first: limit,
    orderBy: 'updatedAt'
  });

  const result = issues.nodes.map(issue => ({
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state?.name,
    url: issue.url
  }));

  console.log(JSON.stringify({ query, results: result }, null, 2));
}

async function findIssueByIdentifier(issueId) {
  const match = issueId.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    return null;
  }
  const [, teamKey, numberStr] = match;
  const number = parseInt(numberStr);

  const team = await getTeam(teamKey);
  const issues = await linear.issues({
    filter: {
      team: { id: { eq: team.id } },
      number: { eq: number }
    },
    first: 1
  });

  return issues.nodes[0] || null;
}

async function updateIssue(issueId, opts = {}) {
  const issue = await findIssueByIdentifier(issueId);
  if (!issue) {
    console.log(JSON.stringify({ success: false, error: `Issue ${issueId} not found` }));
    return;
  }

  const updateData = {};
  if (opts.title) updateData.title = opts.title;
  if (opts.description) updateData.description = opts.description;
  if (opts.priority) updateData.priority = parseInt(opts.priority);

  if (opts.team) {
    const newTeam = await getTeam(opts.team);
    updateData.teamId = newTeam.id;
  }

  if (opts.status) {
    const team = await issue.team;
    const states = await team.states();
    const stateMap = {
      'todo': states.nodes.find(s => s.type === 'unstarted'),
      'in_progress': states.nodes.find(s => s.type === 'started'),
      'done': states.nodes.find(s => s.type === 'completed'),
      'canceled': states.nodes.find(s => s.type === 'canceled')
    };
    const newState = stateMap[opts.status];
    if (newState) updateData.stateId = newState.id;
  }

  await linear.updateIssue(issue.id, updateData);

  const updated = await linear.issue(issue.id);
  console.log(JSON.stringify({
    success: true,
    identifier: updated.identifier,
    previousIdentifier: issueId !== updated.identifier ? issueId : undefined,
    updated: Object.keys(updateData)
  }, null, 2));
}

async function getIssue(issueId) {
  const issue = await findIssueByIdentifier(issueId);
  if (!issue) {
    console.log(JSON.stringify({ success: false, error: `Issue ${issueId} not found` }));
    return;
  }

  const state = await issue.state;
  const assignee = await issue.assignee;

  console.log(JSON.stringify({
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: state?.name,
    assignee: assignee?.name,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt
  }, null, 2));
}

function parseArgs(args) {
  const opts = {};
  let positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        opts[key] = value;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, opts };
}

async function main() {
  const args = process.argv.slice(2);
  const { positional, opts } = parseArgs(args);
  const command = positional[0];

  try {
    switch (command) {
      case 'create':
        await createIssue(positional[1], opts);
        break;
      case 'list':
        await listIssues(opts);
        break;
      case 'search':
        await searchIssues(positional[1], opts);
        break;
      case 'update':
        await updateIssue(positional[1], opts);
        break;
      case 'get':
        await getIssue(positional[1]);
        break;
      default:
        console.log(`Usage: linear <command> [args]

Commands:
  create "title" [--description "..."] [--priority 1-4]
  list [--status open|done|all] [--limit N]
  search "query" [--limit N]
  update ISSUE-ID [--status todo|in_progress|done] [--title "..."] [--team TEAM_KEY]
  get ISSUE-ID

Environment:
  LINEAR_API_KEY  - Required
  LINEAR_TEAM_KEY - Team key (default: FB)`);
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  }
}

main();

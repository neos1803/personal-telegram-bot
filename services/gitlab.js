require('dotenv').config();
const { Gitlab } = require('@gitbeaker/rest');

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_USERNAME = process.env.GITLAB_USERNAME;
const GITLAB_HOST = process.env.GITLAB_HOST;

const api = new Gitlab({ token: GITLAB_TOKEN, host: GITLAB_HOST });

/**
 * Fetch recent contributions from GitLab using Gitbeaker
 * @param {number} days - Number of days to look back (default: 7)
 * @returns {Promise<Array>} Array of recent contributions
 */
async function getRecentContributions(days = 7) {
  try {
    const user = await getUserByUsername(GITLAB_USERNAME);
    if (!user) return [];

    const userId = user?.id;
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Fetch projects owned or accessible by the user
    const projects = await api.Users.allProjects(userId, { perPage: 100 });

    let contributions = [];

    // For each project, fetch recent commits since the given date
    for (const project of projects) {
      try {
        const commits = await api.Commits.all(project.id, { since: since.toISOString(), perPage: 50 });

        const recentCommits = commits.filter(c => {
          if (!c.created_at) return true; // keep if timestamp not present
          return new Date(c.created_at) > since;
        });

        const formatted = recentCommits.map(c => ({
          project: project.name,
          action: 'commit',
          target: c.title || c.message?.split('\n')[0] || c.id,
          createdAt: new Date(c.created_at || Date.now()).toLocaleString(),
          url: `${project.web_url}/-/commit/${c.id}`
        }));

        contributions = contributions.concat(formatted);
      } catch (err) {
        console.error(`Error fetching commits for project ${project.id}:`, err.message);
      }
    }

    return contributions;
  } catch (error) {
    console.error('Error fetching GitLab contributions:', error.message);
    throw error;
  }
}

/**
 * Get user object by username
 */
async function getUserByUsername(username) {
  try {
    const results = await api.Users.showCurrentUser();
    return results && results.length ? results : null;
  } catch (error) {
    console.error('Error fetching GitLab user:', error.message);
    throw error;
  }
}

module.exports = {
  getRecentContributions,
  getUserByUsername
};

import { useChangesJobs, useChangesCommits, useChangesPulls } from '@/api/hooks'
import { GitCommit, GitPullRequest, Zap, ExternalLink } from 'lucide-react'

export default function Changes() {
  const jobs = useChangesJobs()
  const commits = useChangesCommits()
  const pulls = useChangesPulls()

  const isLoading = jobs.isLoading || commits.isLoading || pulls.isLoading

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Change Management</p>
          <h1>Changes</h1>
          <p>Recent infrastructure changes from AWX workflows and Forgejo repositories.</p>
        </div>
      </div>

      {/* Recent Jobs */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            Recent AWX Jobs
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading jobs...</div>
          ) : jobs.data?.jobs?.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted text-sm">No recent jobs</div>
          ) : (
            jobs.data?.jobs?.slice(0, 10).map((job: typeof jobs.data.jobs[0], i: number) => (
              <div key={i} className="px-6 py-4 hover:bg-panel/30 transition">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-sm">{job.name}</h3>
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted">
                      <span className={`inline-block px-2 py-1 rounded font-semibold ${
                        job.status === 'successful' ? 'bg-green-500/20 text-green-400' :
                        job.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                        job.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-gray-500/20 text-gray-400'
                      }`}>
                        {job.status}
                      </span>
                      <span>Job #{job.id}</span>
                      {job.elapsed && <span>{job.elapsed.toFixed(1)}s</span>}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted">
                    {job.started && new Date(job.started).toLocaleString()}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recent Commits */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitCommit className="w-5 h-5 text-green-500" />
            Recent Commits
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading commits...</div>
          ) : commits.data?.repos?.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted text-sm">No recent commits</div>
          ) : (
            commits.data?.repos?.map((repo: typeof commits.data.repos[0]) => (
              <div key={repo.name}>
                <div className="px-6 py-3 bg-panel/30 font-semibold text-sm">{repo.name}</div>
                {repo.commits.slice(0, 5).map((commit: typeof repo.commits[0], i: number) => (
                  <div key={i} className="px-6 py-3 hover:bg-panel/30 transition text-xs border-b border-panel/50 last:border-b-0">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-muted text-xs">{commit.sha_short}</p>
                        <p className="truncate mt-1">{commit.message}</p>
                        <p className="text-muted mt-1">{commit.author}</p>
                      </div>
                      <div className="text-right text-muted shrink-0">
                        {commit.date && new Date(commit.date).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Open Pull Requests */}
      <div className="panel">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitPullRequest className="w-5 h-5 text-blue-500" />
            Pull Requests
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading PRs...</div>
          ) : pulls.data?.pulls?.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted text-sm">No pull requests</div>
          ) : (
            pulls.data?.pulls?.map((pr: typeof pulls.data.pulls[0], i: number) => (
              <div key={i} className="px-6 py-4 hover:bg-panel/30 transition">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${
                        pr.state === 'open' ? 'bg-green-500' : 'bg-purple-500'
                      }`}></span>
                      <h3 className="font-semibold text-sm truncate">{pr.title}</h3>
                    </div>
                    <p className="text-xs text-muted">
                      {pr.repo} #{pr.number} by {pr.author}
                    </p>
                  </div>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-400 shrink-0"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

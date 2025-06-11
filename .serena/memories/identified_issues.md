# Identified Issues from Testing

## Critical Issues Found:

1. **Schema Validation Error** 
   - `github_get_file_content` and `github_get_readme` return string content directly
   - MCP SDK expects content to be an array format
   - Error: "Expected array, received string" for content field

2. **Incomplete Issue/PR Details**
   - `github_get_issue` returns minimal data instead of full issue details
   - `github_get_pull` returns 404 errors for existing PRs
   - Both tools are being summarized when they should return detailed data

3. **Missing Content Structure**
   - File content and README tools return raw object instead of MCP-compliant format
   - Should return `{ content: [{ type: 'text', text: '...' }] }`

## Working Tools:
- ✅ `github_repo_info` - Perfect
- ✅ `github_list_contents` - Excellent  
- ✅ `github_search_code` - Works great
- ✅ `github_list_issues` - Good (lists)
- ✅ `github_list_pulls` - Works (lists)
- ✅ `github_list_branches` - Functional
- ✅ `github_user_info` - Works

## Broken Tools:
- ❌ `github_get_file_content` - Schema error
- ❌ `github_get_readme` - Schema error  
- ❌ `github_get_issue` - Minimal data only
- ❌ `github_get_pull` - 404 errors
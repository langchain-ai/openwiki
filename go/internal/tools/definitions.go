package tools

import (
	"github.com/sashabaranov/go-openai"
)

// Definitions returns OpenAI function tool definitions for the agent.
func Definitions() []openai.Tool {
	return []openai.Tool{
		tool("ls", "List files and directories at a virtual path.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "Virtual path to list, e.g. / or /src",
				},
			},
		}),
		tool("read_file", "Read a file at a virtual path with optional offset and limit.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "Virtual path to read",
				},
				"offset": map[string]any{
					"type":        "integer",
					"description": "Line offset (0-based)",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Maximum number of lines to read",
				},
			},
			"required": []string{"path"},
		}),
		tool("write_file", "Write content to a file at a virtual path.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "Virtual path to write",
				},
				"content": map[string]any{
					"type":        "string",
					"description": "File content",
				},
			},
			"required": []string{"path", "content"},
		}),
		tool("edit_file", "Replace old_string with new_string in a file.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "Virtual path to edit",
				},
				"old_string": map[string]any{
					"type":        "string",
					"description": "Text to replace",
				},
				"new_string": map[string]any{
					"type":        "string",
					"description": "Replacement text",
				},
				"replace_all": map[string]any{
					"type":        "boolean",
					"description": "Replace all occurrences",
				},
			},
			"required": []string{"path", "old_string", "new_string"},
		}),
		tool("glob", "Find files matching a glob pattern under a virtual path.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{
					"type":        "string",
					"description": "Glob pattern, e.g. *.go",
				},
				"path": map[string]any{
					"type":        "string",
					"description": "Virtual directory to search from",
				},
			},
			"required": []string{"pattern"},
		}),
		tool("grep", "Search file contents for a regex pattern.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{
					"type":        "string",
					"description": "Regular expression pattern",
				},
				"path": map[string]any{
					"type":        "string",
					"description": "Virtual directory to search from",
				},
				"glob": map[string]any{
					"type":        "string",
					"description": "Optional filename glob filter",
				},
			},
			"required": []string{"pattern"},
		}),
		tool("execute", "Execute a shell command in the repository root.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{
					"type":        "string",
					"description": "Shell command to run",
				},
			},
			"required": []string{"command"},
		}),
	}
}

func tool(name, description string, schema map[string]any) openai.Tool {
	return openai.Tool{
		Type: openai.ToolTypeFunction,
		Function: &openai.FunctionDefinition{
			Name:        name,
			Description: description,
			Parameters:  schema,
			Strict:      false,
		},
	}
}


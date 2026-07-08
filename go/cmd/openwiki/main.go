package main

import (
	"os"

	"github.com/langchain-ai/openwiki/go/internal/cmd"
)

func main() {
	root := cmd.NewRoot()
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

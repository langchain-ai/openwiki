package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/langchain-ai/openwiki/go/internal/constants"
	"github.com/langchain-ai/openwiki/go/internal/diagnostics"
	"github.com/langchain-ai/openwiki/go/internal/runner"
	"github.com/spf13/cobra"
)

var (
	modelFlag   string
	messageFlag string
	printFlag   bool
)

// NewRoot creates the root Cobra command.
func NewRoot() *cobra.Command {
	root := &cobra.Command{
		Use:          "openwiki",
		Short:        "Headless OpenWiki documentation agent",
		SilenceUsage: true,
		Version:      constants.OpenWikiVersion,
		RunE:         runLegacyRoot,
	}

	root.PersistentFlags().StringVarP(&modelFlag, "model", "M", "", "OpenRouter model ID for this run")

	root.Flags().Bool("init", false, "Generate initial OpenWiki documentation (legacy flag)")
	root.Flags().Bool("update", false, "Update existing OpenWiki documentation (legacy flag)")
	root.Flags().BoolVarP(&printFlag, "print", "p", false, "Print final assistant output to stdout")
	root.Flags().StringVarP(&messageFlag, "message", "m", "", "Additional instruction for the run")

	root.AddCommand(newInitCommand())
	root.AddCommand(newUpdateCommand())
	root.AddCommand(newPrintCommand())

	return root
}

func runLegacyRoot(cmd *cobra.Command, args []string) error {
	initFlag, _ := cmd.Flags().GetBool("init")
	updateFlag, _ := cmd.Flags().GetBool("update")

	if initFlag && updateFlag {
		return fmt.Errorf("--init and --update cannot be used together")
	}

	if initFlag {
		return executeRun(constants.CommandInit, printFlag, joinMessage(args))
	}
	if updateFlag {
		return executeRun(constants.CommandUpdate, printFlag, joinMessage(args))
	}

	if printFlag {
		msg := messageFlag
		if msg == "" {
			msg = joinMessage(args)
		}
		if msg == "" {
			return fmt.Errorf("-p/--print requires a message, --init, or --update")
		}
		return executeRun(constants.CommandChat, true, msg)
	}

	return cmd.Help()
}

func newInitCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Generate initial OpenWiki documentation",
		RunE:  runInit,
	}
	cmd.Flags().StringVarP(&messageFlag, "message", "m", "", "Additional instruction for the init run")
	return cmd
}

func newUpdateCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update existing OpenWiki documentation",
		RunE:  runUpdate,
	}
	cmd.Flags().StringVarP(&messageFlag, "message", "m", "", "Additional instruction for the update run")
	cmd.Flags().BoolVarP(&printFlag, "print", "p", false, "Print final assistant output to stdout")
	return cmd
}

func newPrintCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "print",
		Short: "Run once and print the final assistant output",
		RunE:  runPrint,
	}
	cmd.Flags().StringVarP(&messageFlag, "message", "m", "", "Message to send to the agent")
	cmd.MarkFlagRequired("message")
	return cmd
}

func runInit(cmd *cobra.Command, args []string) error {
	return executeRun(constants.CommandInit, false, joinMessage(args))
}

func runUpdate(cmd *cobra.Command, args []string) error {
	return executeRun(constants.CommandUpdate, printFlag, joinMessage(args))
}

func runPrint(cmd *cobra.Command, args []string) error {
	msg := messageFlag
	if msg == "" {
		msg = joinMessage(args)
	}
	if msg == "" {
		return fmt.Errorf("print requires a message via --message or a positional argument")
	}
	return executeRun(constants.CommandChat, true, msg)
}

func joinMessage(args []string) string {
	if len(args) == 0 {
		return messageFlag
	}
	combined := ""
	for i, arg := range args {
		if i > 0 {
			combined += " "
		}
		combined += arg
	}
	if messageFlag != "" {
		return messageFlag + " " + combined
	}
	return combined
}

func executeRun(command constants.Command, printMode bool, userMessage string) error {
	ctx := context.Background()
	_, err := runner.Run(ctx, runner.Options{
		Command:     command,
		ModelFlag:   modelFlag,
		UserMessage: userMessage,
		PrintMode:   printMode,
	})
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, diagnostics.GetErrorMessage(err))
		return err
	}
	return nil
}

from managed_deepagents import define_deep_agent

agent = define_deep_agent(
    name="openwiki-topic-brain",
    model="openai:gpt-5.5",
    tools=[{"type": "web_search"}],
)

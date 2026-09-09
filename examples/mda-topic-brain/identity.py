from managed_deepagents import auth, define_identity

identity = define_identity(auth=auth.langsmith_api_key())

import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class OxylabsWebApi implements ICredentialType {
	name = 'oxylabsWebApi';

	displayName = 'Oxylabs Web API';

	icon: Icon = { light: 'file:../icons/oxylabs.svg', dark: 'file:../icons/oxylabs.dark.svg' };

	documentationUrl = 'https://github.com/oxylabs/n8n-nodes-oxylabs-web-api#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Your Oxylabs Web API key, from the Oxylabs dashboard',
		},
	];

	// The key is trimmed: a pasted key often carries a trailing newline, which the API rejects.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey.trim()}}',
			},
		},
	};

	// Listing the scrapers is free and answers 401 to a wrong key.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://webapi.oxylabs.io',
			url: '/v1/scrapers',
			method: 'GET',
		},
	};
}

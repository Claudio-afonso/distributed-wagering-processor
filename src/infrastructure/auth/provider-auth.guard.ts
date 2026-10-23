import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

export interface ProviderIdentity {
  providerId: string;
  authenticated: boolean;
}

export abstract class ProviderIdentityPort {
  abstract verifyToken(authorizationHeader?: string): Promise<ProviderIdentity | null>;
}

@Injectable()
export class NoOpProviderIdentityAdapter extends ProviderIdentityPort {
  async verifyToken(authorizationHeader?: string): Promise<ProviderIdentity | null> {
    // Em ambiente produtivo com Keycloak/Zitadel, este adapter valida o JWT via JWKS (OIDC Client Credentials).
    // Conforme Seção 2 do desafio, deixamos a porta explícita e aceitamos chamadas locais por padrão,
    // a menos que AUTH_STRICT_MODE="true" seja configurado.
    if (process.env.AUTH_STRICT_MODE === 'true') {
      if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
        return null;
      }
      const token = authorizationHeader.slice('Bearer '.length).trim();
      if (!token) return null;
      return { providerId: token, authenticated: true };
    }

    return { providerId: 'trusted-provider', authenticated: true };
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private readonly identityPort: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const path: string = request.url ?? '';

    // Seção 2 e 9: Os endpoints de health não devem exigir autenticação
    if (path.startsWith('/health')) {
      return true;
    }

    const identity = await this.identityPort.verifyToken(request.headers?.['authorization']);
    if (!identity) {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Valid external IdP Bearer token required',
      });
    }

    request.providerIdentity = identity;
    return true;
  }
}
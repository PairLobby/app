export interface SignupRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phoneNumber: string;
  address?: string;
  plateNumber: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
}

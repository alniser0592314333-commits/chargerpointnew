import React from 'react';
import { CustomerQrPage } from './CustomerQrPage';

export interface CustomerQrDesignPageProps {
  customerId: string;
}

export const CustomerQrDesignPage: React.FC<CustomerQrDesignPageProps> = ({ customerId }) => {
  return <CustomerQrPage customerId={customerId} />;
};

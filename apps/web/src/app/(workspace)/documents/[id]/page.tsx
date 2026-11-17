import { DocumentDetail } from '../../../../components/document-detail';
export default async function DocumentPage({ params, searchParams }: {
  params: Promise<{
    id: string;
  }>;
  searchParams: Promise<{
    review?: string;
  }>;
}) { const { id } = await params, query = await searchParams; return <DocumentDetail id={id} {...(query.review ? { reviewInvoice: query.review } : {})} />; }
